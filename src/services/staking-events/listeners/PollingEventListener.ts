// Polling Event Listener
// Fallback event listening using eth_getLogs with optimized batch queries

import { ethers, JsonRpcProvider, Log } from 'ethers';
import { logger } from '../../../utils/logger';
import {
  IEventListener,
  STAKING_PRECOMPILE_ADDRESS,
  ListenerConnectionError,
  EVENT_SIGNATURES
} from '../types';

interface PollingConfig {
  rpcUrl: string;
  pollingInterval?: number; // milliseconds
  batchSize?: number; // number of blocks per query
  startBlock?: number;
}

/**
 * Production-ready Polling Event Listener
 *
 * Features:
 * - Optimized batch getLogs queries
 * - Automatic retry with backoff
 * - Gap detection and recovery
 * - Rate limit handling
 */
export class PollingEventListener implements IEventListener {
  private provider: JsonRpcProvider | null = null;
  private config: PollingConfig;
  private _isActive = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastProcessedBlock = 0;
  private currentBlock = 0;
  private isPolling = false;

  // Callbacks
  private eventCallback: ((log: Log) => Promise<void>) | null = null;
  private errorCallback: ((error: Error) => void) | null = null;

  // Stats
  private totalQueries = 0;
  private totalEvents = 0;
  private totalErrors = 0;

  constructor(config: PollingConfig) {
    this.config = {
      pollingInterval: 2000, // 2 seconds
      batchSize: 1000, // blocks per query
      startBlock: 0,
      ...config
    };

    if (config.startBlock) {
      this.lastProcessedBlock = config.startBlock;
    }

    logger.info('PollingEventListener initialized', {
      rpcUrl: this.config.rpcUrl,
      pollingInterval: this.config.pollingInterval,
      batchSize: this.config.batchSize,
      startBlock: this.lastProcessedBlock
    });
  }

  /**
   * Start polling for events
   */
  async start(): Promise<void> {
    if (this._isActive) {
      logger.warn('Polling listener already active');
      return;
    }

    logger.info('Starting polling listener...');

    try {
      // Create provider
      this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);

      // Get current block
      this.currentBlock = await this.provider.getBlockNumber();

      // If no start block specified, start from current
      if (this.lastProcessedBlock === 0) {
        this.lastProcessedBlock = this.currentBlock;
        logger.info('No start block specified, starting from current', {
          startBlock: this.currentBlock
        });
      }

      this._isActive = true;

      // Start polling
      this.startPolling();

      logger.info('Polling listener started successfully', {
        currentBlock: this.currentBlock,
        lastProcessedBlock: this.lastProcessedBlock
      });
    } catch (error) {
      this._isActive = false;
      throw new ListenerConnectionError(
        `Failed to start polling listener: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { rpcUrl: this.config.rpcUrl }
      );
    }
  }

  /**
   * Stop polling for events
   */
  async stop(): Promise<void> {
    logger.info('Stopping polling listener...');

    this._isActive = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.provider = null;

    logger.info('Polling listener stopped', {
      totalQueries: this.totalQueries,
      totalEvents: this.totalEvents,
      totalErrors: this.totalErrors
    });
  }

  /**
   * Check if listener is currently active
   */
  isActive(): boolean {
    return this._isActive;
  }

  /**
   * Get listener type
   */
  getType(): 'websocket' | 'polling' {
    return 'polling';
  }

  /**
   * Subscribe to new events
   */
  onEvent(callback: (log: Log) => Promise<void>): void {
    this.eventCallback = callback;
  }

  /**
   * Subscribe to errors
   */
  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  /**
   * Get current block lag
   */
  getCurrentLag(): number {
    return this.currentBlock - this.lastProcessedBlock;
  }

  /**
   * Start polling loop
   */
  private startPolling(): void {
    const interval = this.config.pollingInterval || 2000;

    this.pollingInterval = setInterval(() => {
      if (!this._isActive || this.isPolling) {
        return;
      }

      this.poll().catch((error) => {
        logger.error('Polling error', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        if (this.errorCallback) {
          this.errorCallback(error instanceof Error ? error : new Error('Unknown polling error'));
        }
      });
    }, interval);

    logger.info('Polling started', { intervalMs: interval });
  }

  /**
   * Poll for new events
   */
  private async poll(): Promise<void> {
    if (!this.provider || this.isPolling) {
      return;
    }

    this.isPolling = true;

    try {
      // Get current block
      this.currentBlock = await this.provider.getBlockNumber();

      // Check if there are new blocks to process
      if (this.lastProcessedBlock >= this.currentBlock) {
        logger.debug('No new blocks to process', {
          lastProcessed: this.lastProcessedBlock,
          current: this.currentBlock
        });
        return;
      }

      // Calculate range to query
      const batchSize = this.config.batchSize || 1000;
      const toBlock = Math.min(
        this.lastProcessedBlock + batchSize,
        this.currentBlock
      );

      logger.debug('Polling for events', {
        fromBlock: this.lastProcessedBlock + 1,
        toBlock,
        blockRange: toBlock - this.lastProcessedBlock
      });

      // Query logs
      const logs = await this.queryLogs(this.lastProcessedBlock + 1, toBlock);

      this.totalQueries++;
      this.totalEvents += logs.length;

      logger.info('Retrieved events', {
        fromBlock: this.lastProcessedBlock + 1,
        toBlock,
        eventCount: logs.length,
        lag: this.getCurrentLag()
      });

      // Forward logs to indexer for processing
      if (this.eventCallback && logs.length > 0) {
        for (const log of logs) {
          await this.eventCallback(log);
        }
      }

      // Update last processed block
      this.lastProcessedBlock = toBlock;
    } catch (error) {
      this.totalErrors++;

      logger.error('Poll failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        lastProcessedBlock: this.lastProcessedBlock,
        currentBlock: this.currentBlock
      });

      if (this.errorCallback) {
        this.errorCallback(error instanceof Error ? error : new Error('Unknown polling error'));
      }

      // On error, wait before retrying (handled by polling interval)
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Query logs with retry logic
   */
  private async queryLogs(fromBlock: number, toBlock: number, retries = 3): Promise<Log[]> {
    if (!this.provider) {
      throw new Error('Provider not initialized');
    }

    const filter = {
      address: STAKING_PRECOMPILE_ADDRESS,
      fromBlock,
      toBlock,
      topics: [Object.values(EVENT_SIGNATURES) as string[]]
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const logs = await this.provider.getLogs(filter);
        return logs as Log[];
      } catch (error: any) {
        const isLastAttempt = attempt === retries;
        const isRateLimit = error?.message?.toLowerCase().includes('rate limit');

        if (isRateLimit) {
          logger.warn('Rate limit detected, backing off', {
            attempt,
            retries,
            backoffMs: attempt * 2000
          });

          // Exponential backoff for rate limits
          await this.sleep(attempt * 2000);

          if (!isLastAttempt) {
            continue;
          }
        }

        if (isLastAttempt) {
          logger.error('getLogs failed after retries', {
            fromBlock,
            toBlock,
            attempts: retries,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          throw error;
        }

        // Regular retry backoff
        logger.warn('getLogs failed, retrying', {
          fromBlock,
          toBlock,
          attempt,
          retries,
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        await this.sleep(1000 * attempt);
      }
    }

    return [];
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Set last processed block (for recovery)
   */
  setLastProcessedBlock(blockNumber: number): void {
    this.lastProcessedBlock = blockNumber;
    logger.info('Last processed block updated', { blockNumber });
  }

  /**
   * Get polling statistics
   */
  getStats() {
    return {
      isActive: this._isActive,
      currentBlock: this.currentBlock,
      lastProcessedBlock: this.lastProcessedBlock,
      lag: this.getCurrentLag(),
      totalQueries: this.totalQueries,
      totalEvents: this.totalEvents,
      totalErrors: this.totalErrors,
      errorRate: this.totalQueries > 0 ? (this.totalErrors / this.totalQueries * 100).toFixed(2) + '%' : '0%'
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.totalQueries = 0;
    this.totalEvents = 0;
    this.totalErrors = 0;
    logger.info('Stats reset');
  }
}
