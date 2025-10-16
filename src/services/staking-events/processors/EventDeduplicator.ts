// Event Deduplicator
// Prevents duplicate event processing using bloom filter + database verification

import { logger } from '../../../utils/logger';
import { IEventDeduplicator, DeduplicationError } from '../types';
import type { MonadClickHouseClient } from '../../../database/clickhouse-client';

/**
 * Simple Bloom Filter implementation for event deduplication
 */
class BloomFilter {
  private bitArray: Uint8Array;
  private size: number;
  private hashCount: number;

  constructor(size: number = 10000, hashCount: number = 3) {
    this.size = size;
    this.hashCount = hashCount;
    this.bitArray = new Uint8Array(Math.ceil(size / 8));
  }

  /**
   * Add an item to the bloom filter
   */
  add(item: string): void {
    for (let i = 0; i < this.hashCount; i++) {
      const hash = this.hash(item, i);
      const bitIndex = hash % this.size;
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;
      this.bitArray[byteIndex] |= (1 << bitOffset);
    }
  }

  /**
   * Check if an item might exist (false positives possible)
   */
  mightContain(item: string): boolean {
    for (let i = 0; i < this.hashCount; i++) {
      const hash = this.hash(item, i);
      const bitIndex = hash % this.size;
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;

      if ((this.bitArray[byteIndex] & (1 << bitOffset)) === 0) {
        return false; // Definitely not present
      }
    }
    return true; // Might be present
  }

  /**
   * Simple hash function
   */
  private hash(str: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Clear the bloom filter
   */
  clear(): void {
    this.bitArray.fill(0);
  }

  /**
   * Get memory usage in bytes
   */
  getMemoryUsage(): number {
    return this.bitArray.length;
  }
}

/**
 * Production-ready Event Deduplicator
 *
 * Two-tier deduplication:
 * 1. Bloom filter (fast, in-memory check)
 * 2. Database verification (accurate, slower)
 */
export class EventDeduplicator implements IEventDeduplicator {
  private bloomFilter: BloomFilter;
  private clickhouse: MonadClickHouseClient;
  private processingSet: Set<string>; // Currently processing events
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Stats
  private bloomFilterHits = 0;
  private bloomFilterMisses = 0;
  private databaseHits = 0;
  private databaseMisses = 0;

  constructor(clickhouse: MonadClickHouseClient, bloomFilterSize: number = 100000) {
    this.clickhouse = clickhouse;
    this.bloomFilter = new BloomFilter(bloomFilterSize, 3);
    this.processingSet = new Set();

    // Start periodic cleanup
    this.startCleanup();

    logger.info('EventDeduplicator initialized', {
      bloomFilterSize,
      memoryUsage: this.bloomFilter.getMemoryUsage()
    });
  }

  /**
   * Check if event has already been processed
   */
  async isDuplicate(eventId: string): Promise<boolean> {
    try {
      // Check if currently processing
      if (this.processingSet.has(eventId)) {
        logger.debug('Event currently being processed', { eventId });
        return true;
      }

      // Fast check: bloom filter
      if (!this.bloomFilter.mightContain(eventId)) {
        this.bloomFilterMisses++;
        return false; // Definitely not processed
      }

      this.bloomFilterHits++;

      // Slow check: database verification (bloom filter can have false positives)
      const isProcessed = await this.clickhouse.isStakingEventProcessed(eventId);

      if (isProcessed) {
        this.databaseHits++;
        logger.debug('Duplicate event detected', { eventId });
      } else {
        this.databaseMisses++;
      }

      return isProcessed;
    } catch (error) {
      throw new DeduplicationError(
        `Failed to check duplicate: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { eventId }
      );
    }
  }

  /**
   * Mark event as processed
   */
  async markProcessed(eventId: string): Promise<void> {
    try {
      // Add to bloom filter
      this.bloomFilter.add(eventId);

      // Remove from processing set
      this.processingSet.delete(eventId);

      logger.debug('Event marked as processed', { eventId });
    } catch (error) {
      throw new DeduplicationError(
        `Failed to mark event as processed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { eventId }
      );
    }
  }

  /**
   * Batch mark multiple events as processed
   */
  async markBatchProcessed(eventIds: string[]): Promise<void> {
    try {
      for (const eventId of eventIds) {
        this.bloomFilter.add(eventId);
        this.processingSet.delete(eventId);
      }

      logger.debug(`Batch marked ${eventIds.length} events as processed`);
    } catch (error) {
      throw new DeduplicationError(
        `Failed to mark batch as processed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { eventIdsCount: eventIds.length }
      );
    }
  }

  /**
   * Mark event as currently processing (prevent concurrent processing)
   */
  markProcessing(eventId: string): void {
    this.processingSet.add(eventId);
  }

  /**
   * Clean up old entries from bloom filter
   * Note: Bloom filters can't delete individual items, so we rebuild periodically
   */
  async cleanup(olderThanBlocks: number): Promise<void> {
    try {
      logger.info('Starting deduplicator cleanup', { olderThanBlocks });

      // Get current block
      const currentBlock = await this.getCurrentBlock();
      const cutoffBlock = currentBlock - olderThanBlocks;

      logger.info('Rebuilding bloom filter from recent events', {
        currentBlock,
        cutoffBlock,
        olderThanBlocks
      });

      // Rebuild bloom filter from recent database records
      const recentEvents = await this.clickhouse.executeRawQuery(`
        SELECT event_id
        FROM staking_events
        WHERE block_number >= ${cutoffBlock}
      `);

      // Clear and rebuild
      this.bloomFilter.clear();
      for (const event of recentEvents) {
        this.bloomFilter.add(event.event_id);
      }

      logger.info('Bloom filter rebuilt', {
        eventCount: recentEvents.length,
        memoryUsage: this.bloomFilter.getMemoryUsage()
      });

      // Log stats
      this.logStats();
    } catch (error) {
      logger.error('Cleanup failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get current blockchain block number
   */
  private async getCurrentBlock(): Promise<number> {
    try {
      const result = await this.clickhouse.executeRawQuery(`
        SELECT max(block_number) as current_block
        FROM staking_events
      `);
      return Number(result[0]?.current_block || 0);
    } catch (error) {
      logger.warn('Failed to get current block, using 0', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return 0;
    }
  }

  /**
   * Start periodic cleanup (every 24 hours, clean up events older than 7 days)
   */
  private startCleanup(): void {
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
    const BLOCKS_TO_KEEP = 7 * 24 * 60 * 60 / 2; // ~7 days of blocks (2 sec block time)

    this.cleanupInterval = setInterval(() => {
      this.cleanup(BLOCKS_TO_KEEP).catch((error) => {
        logger.error('Scheduled cleanup failed', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      });
    }, CLEANUP_INTERVAL);

    logger.info('Cleanup scheduler started', {
      intervalHours: CLEANUP_INTERVAL / (60 * 60 * 1000),
      blocksToKeep: BLOCKS_TO_KEEP
    });
  }

  /**
   * Stop cleanup scheduler
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('Cleanup scheduler stopped');
    }
  }

  /**
   * Log statistics
   */
  private logStats(): void {
    const totalBloomChecks = this.bloomFilterHits + this.bloomFilterMisses;
    const totalDbChecks = this.databaseHits + this.databaseMisses;
    const bloomHitRate = totalBloomChecks > 0
      ? (this.bloomFilterHits / totalBloomChecks * 100).toFixed(2)
      : '0.00';
    const dbHitRate = totalDbChecks > 0
      ? (this.databaseHits / totalDbChecks * 100).toFixed(2)
      : '0.00';

    logger.info('EventDeduplicator stats', {
      bloomFilter: {
        hits: this.bloomFilterHits,
        misses: this.bloomFilterMisses,
        hitRate: `${bloomHitRate}%`,
        memoryUsage: `${(this.bloomFilter.getMemoryUsage() / 1024).toFixed(2)} KB`
      },
      database: {
        hits: this.databaseHits,
        misses: this.databaseMisses,
        hitRate: `${dbHitRate}%`
      },
      currentlyProcessing: this.processingSet.size
    });
  }

  /**
   * Get deduplicator statistics
   */
  getStats() {
    return {
      bloomFilterHits: this.bloomFilterHits,
      bloomFilterMisses: this.bloomFilterMisses,
      databaseHits: this.databaseHits,
      databaseMisses: this.databaseMisses,
      currentlyProcessing: this.processingSet.size,
      memoryUsage: this.bloomFilter.getMemoryUsage()
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.bloomFilterHits = 0;
    this.bloomFilterMisses = 0;
    this.databaseHits = 0;
    this.databaseMisses = 0;
    logger.info('Stats reset');
  }
}
