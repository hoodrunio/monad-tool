// Staking Event Indexer - Main Orchestrator
// Coordinates all components for production-ready event indexing

import { ethers, Log } from 'ethers';
import { logger } from '../../utils/logger';
import type { MonadClickHouseClient } from '../../database/clickhouse-client';
import { EventProcessor } from './processors/EventProcessor';
import { EventDeduplicator } from './processors/EventDeduplicator';
import { WebSocketEventListener } from './listeners/WebSocketEventListener';
import { PollingEventListener } from './listeners/PollingEventListener';
import {
  StakingEventIndexerConfig,
  IEventListener,
  StakingEvent,
  StakingEventRecord,
  ValidatorDelegationRecord,
  DelegationHistoryRecord,
  RewardEventRecord,
  IndexerMetrics,
  StakingEventError,
  STAKING_PRECOMPILE_ADDRESS
} from './types';

/**
 * Production-Ready Staking Event Indexer
 *
 * Architecture:
 * - WebSocket-first with automatic polling fallback
 * - Event processing with validation
 * - Deduplication with bloom filter
 * - Batch database writes
 * - Delegation state management
 * - Comprehensive error handling
 */
export class StakingEventIndexer {
  private clickhouse: MonadClickHouseClient;
  private config: Required<StakingEventIndexerConfig>;

  // Core components
  private eventProcessor: EventProcessor;
  private deduplicator: EventDeduplicator;
  private currentListener: IEventListener | null = null;

  // State
  private isRunning = false;
  private startTime: Date | null = null;

  // Metrics
  private metrics: IndexerMetrics = {
    eventsProcessed: 0,
    eventsSkipped: 0,
    eventsFailed: 0,
    currentBlock: 0,
    lastProcessedBlock: 0,
    lag: 0,
    listenerType: 'stopped',
    uptime: 0,
    averageProcessingTime: 0,
    errorRate: 0
  };

  // Processing buffers
  private eventBuffer: StakingEvent[] = [];
  private readonly BATCH_SIZE = 100;
  private readonly BATCH_TIMEOUT = 5000; // 5 seconds
  private batchTimeout: NodeJS.Timeout | null = null;

  constructor(clickhouse: MonadClickHouseClient, config: StakingEventIndexerConfig) {
    this.clickhouse = clickhouse;

    // Fill in defaults
    this.config = {
      rpcUrl: config.rpcUrl,
      wsUrl: config.wsUrl || '',
      startBlock: config.startBlock || 0,
      pollingInterval: config.pollingInterval || 2000,
      batchSize: config.batchSize || 1000,
      reconnectDelay: config.reconnectDelay || 5000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      enableWebSocket: config.enableWebSocket !== false, // default true
      enablePolling: config.enablePolling !== false // default true
    };

    // Initialize components
    this.eventProcessor = new EventProcessor();
    this.deduplicator = new EventDeduplicator(clickhouse);

    logger.info('StakingEventIndexer initialized', {
      config: {
        rpcUrl: this.config.rpcUrl,
        wsUrl: this.config.wsUrl,
        startBlock: this.config.startBlock,
        enableWebSocket: this.config.enableWebSocket,
        enablePolling: this.config.enablePolling
      }
    });
  }

  /**
   * Start the indexer
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Indexer already running');
      return;
    }

    logger.info('🚀 Starting Staking Event Indexer...');

    try {
      this.isRunning = true;
      this.startTime = new Date();

      // Initialize current epoch
      await this.initializeEpoch();

      // Start listener (WebSocket first, then polling if WS fails)
      await this.startListener();

      // Start batch processing
      this.startBatchProcessing();

      logger.info('✅ Staking Event Indexer started successfully', {
        listenerType: this.currentListener?.getType(),
        startBlock: this.config.startBlock
      });
    } catch (error) {
      this.isRunning = false;
      throw new StakingEventError(
        `Failed to start indexer: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'INDEXER_START_ERROR'
      );
    }
  }

  /**
   * Stop the indexer
   */
  async stop(): Promise<void> {
    logger.info('🛑 Stopping Staking Event Indexer...');

    this.isRunning = false;

    // Stop batch timeout
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    // Process remaining events
    if (this.eventBuffer.length > 0) {
      logger.info('Processing remaining events before shutdown', {
        remainingEvents: this.eventBuffer.length
      });
      await this.processBatch();
    }

    // Stop listener
    if (this.currentListener) {
      await this.currentListener.stop();
      this.currentListener = null;
    }

    // Stop deduplicator
    this.deduplicator.stop();

    logger.info('✅ Staking Event Indexer stopped', {
      totalProcessed: this.metrics.eventsProcessed,
      totalSkipped: this.metrics.eventsSkipped,
      totalFailed: this.metrics.eventsFailed
    });
  }

  /**
   * Initialize current epoch from staking precompile
   */
  private async initializeEpoch(): Promise<void> {
    try {
      const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);

      // Call getEpoch() on staking precompile
      const data = '0x757991a8'; // getEpoch() selector
      const result = await provider.call({
        to: STAKING_PRECOMPILE_ADDRESS,
        data
      });

      const epoch = BigInt(ethers.AbiCoder.defaultAbiCoder().decode(['uint64'], result)[0]);

      this.eventProcessor.setCurrentEpoch(epoch);

      logger.info('Current epoch initialized', { epoch: epoch.toString() });
    } catch (error) {
      logger.warn('Failed to initialize epoch, using 0', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      this.eventProcessor.setCurrentEpoch(BigInt(0));
    }
  }

  /**
   * Start event listener (WebSocket first, polling fallback)
   */
  private async startListener(): Promise<void> {
    // Try WebSocket first
    if (this.config.enableWebSocket && this.config.wsUrl) {
      try {
        logger.info('Attempting to start WebSocket listener...');

        const wsListener = new WebSocketEventListener({
          wsUrl: this.config.wsUrl,
          reconnectDelay: this.config.reconnectDelay,
          maxReconnectAttempts: this.config.maxReconnectAttempts
        });

        wsListener.onEvent(this.handleEvent.bind(this));
        wsListener.onError(this.handleListenerError.bind(this));

        await wsListener.start();

        this.currentListener = wsListener;
        this.metrics.listenerType = 'websocket';

        logger.info('✅ WebSocket listener started');
        return;
      } catch (error) {
        logger.warn('WebSocket listener failed to start, falling back to polling', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Fallback to polling
    if (this.config.enablePolling) {
      logger.info('Starting polling listener...');

      const pollingListener = new PollingEventListener({
        rpcUrl: this.config.rpcUrl,
        pollingInterval: this.config.pollingInterval,
        batchSize: this.config.batchSize,
        startBlock: this.config.startBlock
      });

      pollingListener.onEvent(this.handleEvent.bind(this));
      pollingListener.onError(this.handleListenerError.bind(this));

      await pollingListener.start();

      this.currentListener = pollingListener;
      this.metrics.listenerType = 'polling';

      logger.info('✅ Polling listener started');
      return;
    }

    throw new Error('No listener available (both WebSocket and polling disabled)');
  }

  /**
   * Handle listener errors and switch to fallback if needed
   */
  private handleListenerError(error: Error): void {
    logger.error('Listener error', {
      listenerType: this.currentListener?.getType(),
      error: error.message
    });

    // If WebSocket fails and we're not already on polling, switch to polling
    if (
      this.currentListener?.getType() === 'websocket' &&
      this.config.enablePolling
    ) {
      logger.warn('Switching from WebSocket to polling due to errors');

      this.switchToPolling().catch((switchError) => {
        logger.error('Failed to switch to polling', {
          error: switchError instanceof Error ? switchError.message : 'Unknown error'
        });
      });
    }
  }

  /**
   * Switch from WebSocket to polling
   */
  private async switchToPolling(): Promise<void> {
    logger.info('Switching to polling listener...');

    // Stop current listener
    if (this.currentListener) {
      await this.currentListener.stop();
      this.currentListener = null;
    }

    // Start polling listener
    const pollingListener = new PollingEventListener({
      rpcUrl: this.config.rpcUrl,
      pollingInterval: this.config.pollingInterval,
      batchSize: this.config.batchSize,
      startBlock: this.metrics.lastProcessedBlock
    });

    pollingListener.onEvent(this.handleEvent.bind(this));
    pollingListener.onError(this.handleListenerError.bind(this));

    await pollingListener.start();

    this.currentListener = pollingListener;
    this.metrics.listenerType = 'polling';

    logger.info('✅ Switched to polling listener');
  }

  /**
   * Handle incoming event
   */
  private async handleEvent(log: Log): Promise<void> {
    try {
      // Update metrics from log
      this.metrics.currentBlock = log.blockNumber;
      if (log.blockNumber > this.metrics.lastProcessedBlock) {
        this.metrics.lastProcessedBlock = log.blockNumber;
      }
      this.metrics.lag = this.currentListener?.getCurrentLag() || 0;

      // Check for duplicates BEFORE marking as processing
      const eventId = `${log.transactionHash}:${log.index}`;
      const isDuplicate = await this.deduplicator.isDuplicate(eventId);

      if (isDuplicate) {
        this.metrics.eventsSkipped++;
        logger.debug('Duplicate event skipped', { eventId });
        return;
      }

      // Mark as processing only after confirming it's not a duplicate
      this.deduplicator.markProcessing(eventId);

      // Decode raw log into typed staking event using EventProcessor
      const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
      const block = await provider.getBlock(log.blockNumber);
      const blockTimestamp = new Date(Number(block?.timestamp || 0) * 1000);
      const typedEvent = await this.eventProcessor.processLog(log, blockTimestamp);

      if (!typedEvent) {
        this.metrics.eventsSkipped++;
        return;
      }

      // Add to buffer
      this.eventBuffer.push(typedEvent);

      // Process batch if buffer is full
      if (this.eventBuffer.length >= this.BATCH_SIZE) {
        await this.processBatch();
      }
    } catch (error) {
      this.metrics.eventsFailed++;
      logger.error('Failed to handle event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        txHash: log.transactionHash,
        blockNumber: log.blockNumber
      });
    }
  }

  /**
   * Start batch processing timer
   */
  private startBatchProcessing(): void {
    const processBatchPeriodically = () => {
      this.batchTimeout = setTimeout(async () => {
        if (this.eventBuffer.length > 0) {
          await this.processBatch();
        }

        if (this.isRunning) {
          processBatchPeriodically();
        }
      }, this.BATCH_TIMEOUT);
    };

    processBatchPeriodically();
  }

  /**
   * Process batch of events
   */
  private async processBatch(): Promise<void> {
    if (this.eventBuffer.length === 0) {
      return;
    }

    const events = [...this.eventBuffer];
    this.eventBuffer = [];

    const startTime = Date.now();

    try {
      logger.info('Processing event batch', { count: events.length });

      // Convert to database records
      const stakingEventRecords = await this.convertToStakingEventRecords(events);
      const delegationRecords = await this.buildDelegationRecords(events);
      const historyRecords = this.buildDelegationHistory(events);
      const rewardRecords = this.buildRewardRecords(events);

      // Write to database
      await Promise.all([
        this.clickhouse.insertStakingEvents(stakingEventRecords),
        delegationRecords.length > 0 ? this.clickhouse.upsertValidatorDelegations(delegationRecords) : Promise.resolve(),
        historyRecords.length > 0 ? this.clickhouse.insertDelegationHistory(historyRecords) : Promise.resolve(),
        rewardRecords.length > 0 ? this.clickhouse.insertRewardEvents(rewardRecords) : Promise.resolve()
      ]);

      // Mark events as processed
      const eventIds = events.map(e => `${e.transactionHash}:${e.logIndex}`);
      await this.deduplicator.markBatchProcessed(eventIds);

      // Update metrics
      this.metrics.eventsProcessed += events.length;
      const processingTime = Date.now() - startTime;
      this.metrics.averageProcessingTime =
        (this.metrics.averageProcessingTime * (this.metrics.eventsProcessed - events.length) + processingTime) /
        this.metrics.eventsProcessed;

      logger.info('✅ Batch processed successfully', {
        count: events.length,
        processingTimeMs: processingTime,
        totalProcessed: this.metrics.eventsProcessed
      });
    } catch (error) {
      this.metrics.eventsFailed += events.length;

      logger.error('Failed to process batch', {
        error: error instanceof Error ? error.message : 'Unknown error',
        eventCount: events.length
      });

      // Re-add events to buffer for retry (with limit)
      if (this.eventBuffer.length < this.BATCH_SIZE * 2) {
        this.eventBuffer.unshift(...events);
      }
    }
  }

  /**
   * Convert staking events to database records
   */
  private async convertToStakingEventRecords(events: StakingEvent[]): Promise<StakingEventRecord[]> {
    return events.map(event => {
      const baseRecord: StakingEventRecord = {
        event_id: `${event.transactionHash}:${event.logIndex}`,
        event_type: event.eventType,
        block_number: event.blockNumber,
        block_timestamp: this.formatTimestamp(event.blockTimestamp),
        transaction_hash: event.transactionHash,
        log_index: event.logIndex,
        epoch: event.epoch.toString(),
        validator_id: null,
        delegator: null,
        amount: null,
        commission: null,
        old_commission: null,
        new_commission: null,
        activation_epoch: null,
        withdraw_id: null,
        flags: null,
        from_address: null,
        old_epoch: null,
        new_epoch: null,
        processed_at: this.formatTimestamp(new Date())
      };

      // Fill event-specific fields
      switch (event.eventType) {
        case 'ValidatorCreated':
          baseRecord.validator_id = event.validatorId.toString();
          baseRecord.commission = event.commission.toString();
          break;

        case 'ValidatorStatusChanged':
          baseRecord.validator_id = event.validatorId.toString();
          baseRecord.flags = event.flags.toString();
          break;

        case 'Delegate':
          baseRecord.validator_id = event.validatorId.toString();
          baseRecord.delegator = event.delegator;
          baseRecord.amount = event.amount.toString();
          baseRecord.activation_epoch = event.activationEpoch.toString();
          break;

        case 'Undelegate':
          baseRecord.validator_id = event.validatorId.toString();
          baseRecord.delegator = event.delegator;
          baseRecord.amount = event.amount.toString();
          baseRecord.withdraw_id = event.withdrawId;
          baseRecord.activation_epoch = event.activationEpoch.toString();
          break;

        case 'Withdraw':
          baseRecord.validator_id = event.validatorId.toString();
          baseRecord.delegator = event.delegator;
          baseRecord.amount = event.amount.toString();
          baseRecord.withdraw_id = event.withdrawId;
          break;

        case 'ClaimRewards':
          baseRecord.validator_id = event.validatorId.toString();
          baseRecord.delegator = event.delegator;
          baseRecord.amount = event.amount.toString();
          break;

        case 'CommissionChanged':
          baseRecord.validator_id = event.validatorId.toString();
          baseRecord.old_commission = event.oldCommission.toString();
          baseRecord.new_commission = event.newCommission.toString();
          break;

        case 'ValidatorRewarded':
          baseRecord.validator_id = event.validatorId.toString();
          baseRecord.from_address = event.from;
          baseRecord.amount = event.amount.toString();
          break;

        case 'EpochChanged':
          baseRecord.old_epoch = event.oldEpoch.toString();
          baseRecord.new_epoch = event.newEpoch.toString();
          break;
      }

      return baseRecord;
    });
  }

  /**
   * Build delegation records from events
   */
  private async buildDelegationRecords(events: StakingEvent[]): Promise<ValidatorDelegationRecord[]> {
    const records: ValidatorDelegationRecord[] = [];

    for (const event of events) {
      if (event.eventType === 'Delegate' || event.eventType === 'Undelegate' || event.eventType === 'Withdraw' || event.eventType === 'ClaimRewards') {
        const validatorId = event.validatorId.toString();
        const delegator = event.delegator;

        if (!delegator) continue;

        // Get existing delegation record
        const existing = await this.clickhouse.getValidatorDelegation(validatorId, delegator);

        const record: ValidatorDelegationRecord = {
          validator_id: validatorId,
          delegator,
          current_amount: existing?.current_amount || '0',
          total_delegated: existing?.total_delegated || '0',
          total_undelegated: existing?.total_undelegated || '0',
          total_withdrawn: existing?.total_withdrawn || '0',
          total_rewards_claimed: existing?.total_rewards_claimed || '0',
          pending_withdrawals: existing?.pending_withdrawals || 0,
          first_delegation_at: existing?.first_delegation_at || this.formatTimestamp(event.blockTimestamp),
          last_updated_at: this.formatTimestamp(event.blockTimestamp),
          last_updated_block: event.blockNumber,
          epoch: event.epoch.toString()
        };

        // Update based on event type
        if (event.eventType === 'Delegate') {
          const amount = event.amount;
          record.current_amount = (BigInt(record.current_amount) + amount).toString();
          record.total_delegated = (BigInt(record.total_delegated) + amount).toString();
        } else if (event.eventType === 'Undelegate') {
          const amount = event.amount;
          record.current_amount = (BigInt(record.current_amount) - amount).toString();
          record.total_undelegated = (BigInt(record.total_undelegated) + amount).toString();
          record.pending_withdrawals += 1;
        } else if (event.eventType === 'Withdraw') {
          const amount = event.amount;
          record.total_withdrawn = (BigInt(record.total_withdrawn) + amount).toString();
          record.pending_withdrawals = Math.max(0, record.pending_withdrawals - 1);
        } else if (event.eventType === 'ClaimRewards') {
          const amount = event.amount;
          record.total_rewards_claimed = (BigInt(record.total_rewards_claimed) + amount).toString();
        }

        records.push(record);
      }
    }

    return records;
  }

  /**
   * Build delegation history from events
   */
  private buildDelegationHistory(events: StakingEvent[]): DelegationHistoryRecord[] {
    const records: DelegationHistoryRecord[] = [];

    for (const event of events) {
      if (event.eventType === 'Delegate' || event.eventType === 'Undelegate' || event.eventType === 'Withdraw') {
        let action: 'delegate' | 'undelegate' | 'withdraw' | 'compound' = 'delegate';

        if (event.eventType === 'Undelegate') action = 'undelegate';
        else if (event.eventType === 'Withdraw') action = 'withdraw';

        records.push({
          history_id: `${event.transactionHash}:${event.logIndex}`,
          validator_id: event.validatorId.toString(),
          delegator: event.delegator,
          action,
          amount: event.amount.toString(),
          epoch: event.epoch.toString(),
          activation_epoch: 'activationEpoch' in event ? event.activationEpoch.toString() : null,
          withdraw_id: 'withdrawId' in event ? event.withdrawId : null,
          block_number: event.blockNumber,
          block_timestamp: this.formatTimestamp(event.blockTimestamp),
          transaction_hash: event.transactionHash
        });
      }
    }

    return records;
  }

  /**
   * Build reward records from events
   */
  private buildRewardRecords(events: StakingEvent[]): RewardEventRecord[] {
    const records: RewardEventRecord[] = [];

    for (const event of events) {
      if (event.eventType === 'ClaimRewards') {
        records.push({
          event_id: `${event.transactionHash}:${event.logIndex}`,
          validator_id: event.validatorId.toString(),
          delegator: event.delegator,
          amount: event.amount.toString(),
          epoch: event.epoch.toString(),
          event_type: 'claim',
          old_commission: null,
          new_commission: null,
          block_number: event.blockNumber,
          block_timestamp: this.formatTimestamp(event.blockTimestamp),
          transaction_hash: event.transactionHash
        });
      } else if (event.eventType === 'CommissionChanged') {
        records.push({
          event_id: `${event.transactionHash}:${event.logIndex}`,
          validator_id: event.validatorId.toString(),
          delegator: null,
          amount: '0',
          epoch: event.epoch.toString(),
          event_type: 'commission_change',
          old_commission: event.oldCommission.toString(),
          new_commission: event.newCommission.toString(),
          block_number: event.blockNumber,
          block_timestamp: this.formatTimestamp(event.blockTimestamp),
          transaction_hash: event.transactionHash
        });
      } else if (event.eventType === 'ValidatorRewarded') {
        records.push({
          event_id: `${event.transactionHash}:${event.logIndex}`,
          validator_id: event.validatorId.toString(),
          delegator: null,
          amount: event.amount.toString(),
          epoch: event.epoch.toString(),
          event_type: 'validator_reward',
          old_commission: null,
          new_commission: null,
          block_number: event.blockNumber,
          block_timestamp: this.formatTimestamp(event.blockTimestamp),
          transaction_hash: event.transactionHash
        });
      }
    }

    return records;
  }

  /**
   * Format timestamp to ClickHouse format
   */
  private formatTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }

  /**
   * Get indexer metrics
   */
  getMetrics(): IndexerMetrics {
    if (this.startTime) {
      this.metrics.uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    }

    if (this.metrics.eventsProcessed > 0) {
      this.metrics.errorRate = (this.metrics.eventsFailed / this.metrics.eventsProcessed) * 100;
    }

    return { ...this.metrics };
  }

  /**
   * Check if indexer is running
   */
  isIndexerRunning(): boolean {
    return this.isRunning;
  }
}
