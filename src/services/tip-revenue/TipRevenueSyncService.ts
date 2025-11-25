import { TipRevenueService } from './TipRevenueService';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';
import {
  TipRevenueSyncConfig,
  TipRevenueSyncStatus
} from './types';

const REDIS_LAST_BLOCK_KEY = 'tip_revenue:last_processed_block';
const REDIS_BACKFILL_PROGRESS_KEY = 'tip_revenue:backfill_progress';

/**
 * TipRevenueSyncService
 * Background service for synchronizing tip revenue data from blockchain
 */
export class TipRevenueSyncService {
  private tipRevenueService: TipRevenueService;
  private clickhouseClient: MonadClickHouseClient;
  private redisClient: MonadRedisClient;
  private config: TipRevenueSyncConfig;

  private updateTimer: NodeJS.Timeout | null = null;
  private aggregationTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isSyncing = false;
  private isBackfilling = false;
  private lastProcessedBlock = 0;
  private errorCount = 0;
  private lastSyncTime?: Date;

  constructor(
    config: TipRevenueSyncConfig,
    clickhouseClient: MonadClickHouseClient,
    redisClient: MonadRedisClient
  ) {
    this.config = config;
    this.clickhouseClient = clickhouseClient;
    this.redisClient = redisClient;
    this.tipRevenueService = new TipRevenueService(config.rpcUrl);
  }

  /**
   * Initialize the sync service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing TipRevenueSyncService...');

      // Initialize underlying service
      await this.tipRevenueService.initialize();

      // Get last processed block from Redis or database
      await this.loadLastProcessedBlock();

      logger.info(`TipRevenueSyncService initialized. Last processed block: ${this.lastProcessedBlock}`);
    } catch (error) {
      logger.error('Failed to initialize TipRevenueSyncService:', error);
      throw error;
    }
  }

  /**
   * Start the background sync service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('TipRevenueSyncService is already running');
      return;
    }

    this.isRunning = true;
    logger.info(`Starting TipRevenueSyncService with ${this.config.updateIntervalMs}ms interval`);

    // Check if backfill is needed
    if (this.config.enableBackfill && this.lastProcessedBlock === 0) {
      this.startBackfill().catch(error => {
        logger.error('Backfill failed:', error);
      });
    }

    // Run initial sync
    this.performSync().catch(error => {
      logger.error('Initial sync failed:', error);
    });

    // Setup periodic sync
    this.updateTimer = setInterval(async () => {
      try {
        await this.performSync();
      } catch (error) {
        logger.error('Periodic sync failed:', error);
        this.errorCount++;
      }
    }, this.config.updateIntervalMs);

    // Setup hourly aggregation (run every 5 minutes to catch up)
    this.aggregationTimer = setInterval(async () => {
      try {
        await this.runHourlyAggregation();
      } catch (error) {
        logger.error('Hourly aggregation failed:', error);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Stop the background sync service
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
      this.aggregationTimer = null;
    }

    logger.info('TipRevenueSyncService stopped');
  }

  /**
   * Force an immediate sync
   */
  async forceSync(): Promise<void> {
    logger.info('Forcing tip revenue sync...');
    await this.performSync();
  }

  /**
   * Main sync logic
   */
  private async performSync(): Promise<void> {
    if (this.isSyncing || this.isBackfilling) {
      logger.debug('Sync already in progress, skipping...');
      return;
    }

    this.isSyncing = true;

    try {
      const currentBlock = await this.tipRevenueService.getCurrentBlockNumber();
      const lag = currentBlock - this.lastProcessedBlock;

      if (lag <= 0) {
        logger.debug('No new blocks to process');
        return;
      }

      logger.info(`Processing ${lag} blocks (${this.lastProcessedBlock + 1} to ${currentBlock})`);

      // Process in batches
      let processedCount = 0;
      let fromBlock = this.lastProcessedBlock + 1;

      while (fromBlock <= currentBlock) {
        const toBlock = Math.min(fromBlock + this.config.batchSize - 1, currentBlock);

        const count = await this.tipRevenueService.processBlockRange(
          fromBlock,
          toBlock,
          this.clickhouseClient
        );

        processedCount += count;
        this.lastProcessedBlock = toBlock;

        // Save progress
        await this.saveLastProcessedBlock(toBlock);

        fromBlock = toBlock + 1;

        // Small delay between batches
        if (fromBlock <= currentBlock) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      this.lastSyncTime = new Date();
      this.errorCount = 0;

      logger.info(`Sync completed. Processed ${processedCount} blocks.`);

      // Invalidate cache after sync
      await this.invalidateCache();

    } catch (error) {
      logger.error('Sync failed:', error);
      this.errorCount++;
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Start historical backfill
   */
  private async startBackfill(): Promise<void> {
    if (this.isBackfilling) {
      logger.warn('Backfill already in progress');
      return;
    }

    this.isBackfilling = true;

    try {
      const currentBlock = await this.tipRevenueService.getCurrentBlockNumber();
      const startBlock = this.config.backfillStartBlock;

      logger.info(`Starting backfill from block ${startBlock} to ${currentBlock}`);

      let fromBlock = startBlock;
      const batchSize = 100; // Larger batches for backfill

      while (fromBlock <= currentBlock && this.isRunning) {
        const toBlock = Math.min(fromBlock + batchSize - 1, currentBlock);

        await this.tipRevenueService.processBlockRange(
          fromBlock,
          toBlock,
          this.clickhouseClient
        );

        const progress = ((toBlock - startBlock) / (currentBlock - startBlock)) * 100;
        logger.info(`Backfill progress: ${progress.toFixed(1)}% (block ${toBlock}/${currentBlock})`);

        // Save backfill progress
        await this.redisClient.setExpiring(
          REDIS_BACKFILL_PROGRESS_KEY,
          {
            startBlock,
            currentBlock: toBlock,
            targetBlock: currentBlock
          },
          3600 * 24 // 24 hour TTL
        );

        fromBlock = toBlock + 1;

        // Delay between batches to avoid overwhelming RPC
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Update last processed block after backfill
      this.lastProcessedBlock = currentBlock;
      await this.saveLastProcessedBlock(currentBlock);

      // Clear backfill progress by setting empty value with short TTL
      await this.redisClient.setExpiring(REDIS_BACKFILL_PROGRESS_KEY, null, 1);

      logger.info('Backfill completed successfully');

    } catch (error) {
      logger.error('Backfill failed:', error);
      throw error;
    } finally {
      this.isBackfilling = false;
    }
  }

  /**
   * Run hourly aggregation
   * JOIN with block_proposals to get validator_id from block number
   */
  private async runHourlyAggregation(): Promise<void> {
    try {
      logger.info('Running hourly tip revenue aggregation...');

      // ReplacingMergeTree handles deduplication automatically based on ORDER BY (hour, validator_id)
      // When same (hour, validator_id) is inserted, the row with latest updated_at wins
      // No DELETE needed - just INSERT and let ClickHouse handle merging
      //
      // Aggregate last 25 hours of data with validator_id from block_proposals
      // block_proposals.seq_num = block number, status='proposed' for successful blocks
      // Using toFloat64 for large wei values to avoid UInt64 overflow
      const aggregationQuery = `
        INSERT INTO tip_revenue_hourly
        SELECT
          toStartOfHour(t.block_timestamp) AS hour,
          bp.validator_id AS validator_id,
          toString(toUInt64(sum(toFloat64(t.total_tip_wei)))) AS total_tip_wei,
          sum(toFloat64(t.total_tip_wei)) / 1e18 AS total_tip_mon,
          count() AS blocks_proposed,
          sum(t.transaction_count) AS total_transactions,
          toString(toUInt64(sum(toFloat64(t.total_tip_wei)) / greatest(count(), 1))) AS avg_tip_per_block_wei,
          toString(toUInt64(sum(toFloat64(t.total_tip_wei)) / greatest(sum(t.transaction_count), 1))) AS avg_tip_per_tx_wei,
          toString(toUInt64(min(toFloat64(t.total_tip_wei)))) AS min_tip_wei,
          toString(toUInt64(max(toFloat64(t.total_tip_wei)))) AS max_tip_wei,
          now() AS updated_at
        FROM tip_revenue_raw t
        INNER JOIN block_proposals bp ON t.block_number = bp.seq_num AND bp.status = 'proposed'
        WHERE t.block_timestamp >= now() - INTERVAL 25 HOUR
          AND bp.validator_id != ''
        GROUP BY hour, bp.validator_id
      `;

      await this.clickhouseClient.executeCommand(aggregationQuery);

      // Optimize table to merge duplicate rows (ReplacingMergeTree deduplication)
      // This forces immediate merge instead of waiting for background merges
      await this.clickhouseClient.executeCommand('OPTIMIZE TABLE tip_revenue_hourly FINAL');
      logger.info('Optimized tip_revenue_hourly table');

      // Update cumulative totals
      await this.updateCumulativeTotals();

      logger.info('Hourly aggregation completed');

    } catch (error) {
      logger.error('Failed to run hourly aggregation:', error);
      throw error;
    }
  }

  /**
   * Update cumulative totals for all validators
   */
  private async updateCumulativeTotals(): Promise<void> {
    try {
      // ReplacingMergeTree handles deduplication based on ORDER BY (validator_id)
      // Use FINAL in subquery to ensure we read deduplicated hourly data
      // Using toFloat64 for large wei values to avoid overflow
      const cumulativeQuery = `
        INSERT INTO tip_revenue_cumulative
        SELECT
          validator_id,
          toString(toUInt64(tip_wei_sum)) AS total_tip_wei,
          tip_mon_sum AS total_tip_mon,
          blocks_sum AS total_blocks_proposed,
          tx_sum AS total_transactions,
          if(blocks_sum > 0, tip_mon_sum / blocks_sum, 0) AS avg_tip_per_block_mon,
          first_hour AS first_block_timestamp,
          last_hour AS last_block_timestamp,
          now() AS last_updated
        FROM (
          SELECT
            validator_id,
            sum(toFloat64(total_tip_wei)) AS tip_wei_sum,
            sum(total_tip_mon) AS tip_mon_sum,
            sum(blocks_proposed) AS blocks_sum,
            sum(total_transactions) AS tx_sum,
            min(hour) AS first_hour,
            max(hour) AS last_hour
          FROM tip_revenue_hourly FINAL
          WHERE validator_id != ''
          GROUP BY validator_id
        )
      `;

      await this.clickhouseClient.executeCommand(cumulativeQuery);

      // Optimize cumulative table to merge duplicates
      await this.clickhouseClient.executeCommand('OPTIMIZE TABLE tip_revenue_cumulative FINAL');

    } catch (error) {
      logger.error('Failed to update cumulative totals:', error);
      throw error;
    }
  }

  /**
   * Load last processed block from Redis/database
   * If no previous state found and backfill is disabled, start from current block
   */
  private async loadLastProcessedBlock(): Promise<void> {
    try {
      // Try Redis first using getCounter which returns a number
      const redisValue = await this.redisClient.getCounter(REDIS_LAST_BLOCK_KEY);
      if (redisValue > 0) {
        this.lastProcessedBlock = redisValue;
        logger.info(`Loaded last processed block from Redis: ${redisValue}`);
        return;
      }

      // Fall back to database
      const dbQuery = `
        SELECT max(block_number) as last_block
        FROM tip_revenue_raw
      `;

      const result = await this.clickhouseClient.executeRawQuery(dbQuery);
      const lastBlock = parseInt(result[0]?.last_block) || 0;

      if (lastBlock > 0) {
        this.lastProcessedBlock = lastBlock;
        await this.saveLastProcessedBlock(lastBlock);
        logger.info(`Loaded last processed block from database: ${lastBlock}`);
        return;
      }

      // No previous state found - if backfill is disabled, start from current block
      if (!this.config.enableBackfill) {
        const currentBlock = await this.tipRevenueService.getCurrentBlockNumber();
        this.lastProcessedBlock = currentBlock;
        await this.saveLastProcessedBlock(currentBlock);
        logger.info(`No previous sync state found. Backfill disabled. Starting from current block: ${currentBlock}`);
        return;
      }

      // Backfill is enabled, start from backfillStartBlock
      this.lastProcessedBlock = 0;
      logger.info(`No previous sync state found. Backfill enabled. Will start from block: ${this.config.backfillStartBlock}`);

    } catch (error) {
      logger.error('Failed to load last processed block:', error);
      this.lastProcessedBlock = 0;
    }
  }

  /**
   * Save last processed block to Redis
   */
  private async saveLastProcessedBlock(blockNumber: number): Promise<void> {
    try {
      await this.redisClient.setExpiring(
        REDIS_LAST_BLOCK_KEY,
        blockNumber,
        3600 * 24 * 7 // 7 day TTL
      );
    } catch (error) {
      logger.error('Failed to save last processed block:', error);
    }
  }

  /**
   * Invalidate tip revenue cache
   */
  private async invalidateCache(): Promise<void> {
    try {
      await this.redisClient.invalidatePattern('tip_revenue_*');
    } catch (error) {
      logger.error('Failed to invalidate cache:', error);
    }
  }

  /**
   * Get current sync status
   */
  getStatus(): TipRevenueSyncStatus {
    return {
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
      isBackfilling: this.isBackfilling,
      lastProcessedBlock: this.lastProcessedBlock,
      currentBlock: 0, // Will be updated asynchronously
      lag: 0,
      lastSyncTime: this.lastSyncTime,
      errorCount: this.errorCount
    };
  }

  /**
   * Get detailed status with current block info
   */
  async getDetailedStatus(): Promise<TipRevenueSyncStatus> {
    const currentBlock = await this.tipRevenueService.getCurrentBlockNumber();
    const lag = currentBlock - this.lastProcessedBlock;

    let backfillProgress;
    try {
      // Try to get backfill progress from cache
      const cachedProgress = await this.redisClient.getOrSet(
        REDIS_BACKFILL_PROGRESS_KEY,
        async () => null,
        1 // Short TTL since we just want to check if it exists
      );
      if (cachedProgress && typeof cachedProgress === 'object') {
        const progress = cachedProgress as { startBlock: number; currentBlock: number; targetBlock: number };
        backfillProgress = {
          ...progress,
          percentComplete: ((progress.currentBlock - progress.startBlock) /
            (progress.targetBlock - progress.startBlock)) * 100
        };
      }
    } catch {
      // Ignore parsing errors
    }

    return {
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
      isBackfilling: this.isBackfilling,
      lastProcessedBlock: this.lastProcessedBlock,
      currentBlock,
      lag,
      backfillProgress,
      lastSyncTime: this.lastSyncTime,
      errorCount: this.errorCount
    };
  }
}
