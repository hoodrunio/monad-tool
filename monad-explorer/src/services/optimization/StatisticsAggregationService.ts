import { DataSource } from 'typeorm';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { logger } from '../../utils/logger';

/**
 * Statistics Aggregation Service
 * 
 * Maintains pre-computed aggregation tables for optimal query performance.
 * This service populates block_stats, address_stats, and daily_stats tables
 * to avoid expensive real-time calculations on large datasets.
 */
export class StatisticsAggregationService {
  private readonly batchSize = 1000;
  private readonly processingTimeoutMs = 300000; // 5 minutes
  
  constructor(
    private readonly dataSource: DataSource,
    private readonly cacheService: ICacheService
  ) {}

  /**
   * Process new blocks and update aggregation tables
   */
  public async processNewBlocks(fromBlock: number, toBlock: number): Promise<void> {
    const startTime = Date.now();
    
    try {
      logger.info('Starting aggregation processing for new blocks', {
        fromBlock,
        toBlock,
        blockRange: toBlock - fromBlock + 1
      });

      // Process blocks in batches to avoid memory issues
      for (let currentBlock = fromBlock; currentBlock <= toBlock; currentBlock += this.batchSize) {
        const batchEnd = Math.min(currentBlock + this.batchSize - 1, toBlock);
        
        await this.processBatchBlocks(currentBlock, batchEnd);
        
        // Check timeout
        if (Date.now() - startTime > this.processingTimeoutMs) {
          logger.warn('Aggregation processing timed out, will resume later', {
            processedUpTo: batchEnd,
            remaining: toBlock - batchEnd
          });
          break;
        }
      }

      // Refresh materialized views after processing
      await this.refreshMaterializedViews();

      const duration = Date.now() - startTime;
      logger.info('Aggregation processing completed', {
        fromBlock,
        toBlock,
        duration,
        blocksProcessed: toBlock - fromBlock + 1
      });

    } catch (error) {
      logger.error('Failed to process block aggregations', {
        fromBlock,
        toBlock,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Process a batch of blocks for aggregation
   */
  private async processBatchBlocks(fromBlock: number, toBlock: number): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Update block_stats for the batch
      await this.updateBlockStatsBatch(queryRunner, fromBlock, toBlock);

      // 2. Update address_stats for addresses in these blocks
      await this.updateAddressStatsBatch(queryRunner, fromBlock, toBlock);

      // 3. Update daily stats if needed
      await this.updateDailyStatsBatch(queryRunner, fromBlock, toBlock);

      await queryRunner.commitTransaction();

      logger.debug('Processed block batch successfully', {
        fromBlock,
        toBlock,
        batchSize: toBlock - fromBlock + 1
      });

    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Update block_stats table for a batch of blocks
   */
  private async updateBlockStatsBatch(queryRunner: any, fromBlock: number, toBlock: number): Promise<void> {
    // Use efficient aggregation query to calculate block statistics
    const insertQuery = `
      INSERT INTO block_stats (
        block_number, block_hash, timestamp, transaction_count,
        total_gas_used, avg_gas_price, total_value_transferred,
        unique_addresses, contract_interactions
      )
      SELECT 
        b.number,
        b.hash,
        b.timestamp,
        COUNT(t.id) as transaction_count,
        COALESCE(SUM(t.gas_used), 0) as total_gas_used,
        COALESCE(AVG(t.gas_price), 0) as avg_gas_price,
        COALESCE(SUM(t.value), 0) as total_value_transferred,
        COUNT(DISTINCT t.from_address) + COUNT(DISTINCT t.to_address) as unique_addresses,
        COUNT(*) FILTER (WHERE t.is_contract_interaction = true) as contract_interactions
      FROM block b
      LEFT JOIN transaction t ON t.block_id = b.id
      WHERE b.number >= $1 AND b.number <= $2
      GROUP BY b.id, b.number, b.hash, b.timestamp
      ON CONFLICT (block_number) DO UPDATE SET
        transaction_count = EXCLUDED.transaction_count,
        total_gas_used = EXCLUDED.total_gas_used,
        avg_gas_price = EXCLUDED.avg_gas_price,
        total_value_transferred = EXCLUDED.total_value_transferred,
        unique_addresses = EXCLUDED.unique_addresses,
        contract_interactions = EXCLUDED.contract_interactions,
        updated_at = NOW()
    `;

    await queryRunner.query(insertQuery, [fromBlock, toBlock]);
  }

  /**
   * Update address_stats for addresses involved in the block range
   */
  private async updateAddressStatsBatch(queryRunner: any, fromBlock: number, toBlock: number): Promise<void> {
    // Get unique addresses from the block range
    const addressesQuery = `
      SELECT DISTINCT unnest(ARRAY[t.from_address, t.to_address]) as address
      FROM transaction t
      JOIN block b ON t.block_id = b.id
      WHERE b.number >= $1 AND b.number <= $2
      AND unnest(ARRAY[t.from_address, t.to_address]) IS NOT NULL
    `;

    const addresses = await queryRunner.query(addressesQuery, [fromBlock, toBlock]);

    // Process addresses in smaller batches
    const addressBatchSize = 100;
    for (let i = 0; i < addresses.length; i += addressBatchSize) {
      const addressBatch = addresses.slice(i, i + addressBatchSize);
      await this.updateAddressStatsForBatch(queryRunner, addressBatch.map((a: any) => a.address));
    }
  }

  /**
   * Update address statistics for a batch of addresses
   */
  private async updateAddressStatsForBatch(queryRunner: any, addresses: string[]): Promise<void> {
    const updateQuery = `
      INSERT INTO address_stats (
        address, transaction_count, total_sent, total_received,
        first_seen, last_seen, is_contract
      )
      SELECT 
        addr.address,
        COALESCE(tx_stats.transaction_count, 0),
        COALESCE(tx_stats.total_sent, 0),
        COALESCE(tx_stats.total_received, 0),
        tx_stats.first_seen,
        tx_stats.last_seen,
        COALESCE(acc.is_contract, false)
      FROM (SELECT unnest($1::text[]) as address) addr
      LEFT JOIN (
        SELECT 
          address,
          COUNT(*) as transaction_count,
          SUM(CASE WHEN direction = 'sent' THEN value ELSE 0 END) as total_sent,
          SUM(CASE WHEN direction = 'received' THEN value ELSE 0 END) as total_received,
          MIN(timestamp) as first_seen,
          MAX(timestamp) as last_seen
        FROM (
          SELECT from_address as address, value, timestamp, 'sent' as direction
          FROM transaction
          WHERE from_address = ANY($1::text[])
          UNION ALL
          SELECT to_address as address, value, timestamp, 'received' as direction
          FROM transaction
          WHERE to_address = ANY($1::text[])
          AND to_address IS NOT NULL
        ) combined
        GROUP BY address
      ) tx_stats ON addr.address = tx_stats.address
      LEFT JOIN account acc ON addr.address = acc.address
      ON CONFLICT (address) DO UPDATE SET
        transaction_count = EXCLUDED.transaction_count,
        total_sent = EXCLUDED.total_sent,
        total_received = EXCLUDED.total_received,
        first_seen = COALESCE(address_stats.first_seen, EXCLUDED.first_seen),
        last_seen = GREATEST(address_stats.last_seen, EXCLUDED.last_seen),
        is_contract = COALESCE(EXCLUDED.is_contract, address_stats.is_contract),
        updated_at = NOW()
    `;

    await queryRunner.query(updateQuery, [addresses]);
  }

  /**
   * Update daily statistics for the block range
   */
  private async updateDailyStatsBatch(queryRunner: any, fromBlock: number, toBlock: number): Promise<void> {
    const updateQuery = `
      INSERT INTO daily_block_stats (
        date, block_count, transaction_count, total_gas_used,
        avg_gas_price, total_value_transferred, unique_addresses
      )
      SELECT 
        date_trunc('day', b.timestamp)::date as date,
        COUNT(DISTINCT b.number) as block_count,
        COUNT(t.id) as transaction_count,
        COALESCE(SUM(t.gas_used), 0) as total_gas_used,
        COALESCE(AVG(t.gas_price), 0) as avg_gas_price,
        COALESCE(SUM(t.value), 0) as total_value_transferred,
        COUNT(DISTINCT t.from_address) + COUNT(DISTINCT t.to_address) as unique_addresses
      FROM block b
      LEFT JOIN transaction t ON t.block_id = b.id
      WHERE b.number >= $1 AND b.number <= $2
      GROUP BY date_trunc('day', b.timestamp)::date
      ON CONFLICT (date) DO UPDATE SET
        block_count = daily_block_stats.block_count + EXCLUDED.block_count,
        transaction_count = daily_block_stats.transaction_count + EXCLUDED.transaction_count,
        total_gas_used = daily_block_stats.total_gas_used + EXCLUDED.total_gas_used,
        avg_gas_price = (daily_block_stats.avg_gas_price + EXCLUDED.avg_gas_price) / 2,
        total_value_transferred = daily_block_stats.total_value_transferred + EXCLUDED.total_value_transferred,
        unique_addresses = GREATEST(daily_block_stats.unique_addresses, EXCLUDED.unique_addresses),
        created_at = NOW()
    `;

    await queryRunner.query(updateQuery, [fromBlock, toBlock]);
  }

  /**
   * Refresh materialized views for better performance
   */
  private async refreshMaterializedViews(): Promise<void> {
    try {
      await this.dataSource.query('REFRESH MATERIALIZED VIEW CONCURRENTLY latest_blocks_with_stats');
      await this.dataSource.query('REFRESH MATERIALIZED VIEW CONCURRENTLY latest_transactions_preview');
      
      logger.debug('Materialized views refreshed successfully');
    } catch (error) {
      logger.warn('Failed to refresh materialized views', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get the last processed block number
   */
  public async getLastProcessedBlock(): Promise<number> {
    try {
      const result = await this.dataSource.query(
        'SELECT MAX(block_number) as last_block FROM block_stats'
      );
      return result[0]?.last_block || 0;
    } catch (error) {
      logger.warn('Failed to get last processed block', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return 0;
    }
  }

  /**
   * Get statistics about the aggregation process
   */
  public async getAggregationStats(): Promise<{
    blockStatsCount: number;
    addressStatsCount: number;
    dailyStatsCount: number;
    lastProcessedBlock: number;
  }> {
    const [blockStats, addressStats, dailyStats, lastBlock] = await Promise.all([
      this.dataSource.query('SELECT COUNT(*) as count FROM block_stats'),
      this.dataSource.query('SELECT COUNT(*) as count FROM address_stats'),
      this.dataSource.query('SELECT COUNT(*) as count FROM daily_block_stats'),
      this.getLastProcessedBlock()
    ]);

    return {
      blockStatsCount: parseInt(blockStats[0]?.count || '0'),
      addressStatsCount: parseInt(addressStats[0]?.count || '0'),
      dailyStatsCount: parseInt(dailyStats[0]?.count || '0'),
      lastProcessedBlock: lastBlock
    };
  }

  /**
   * Backfill historical data (use with caution)
   */
  public async backfillHistoricalData(
    fromBlock: number, 
    toBlock: number, 
    batchSize: number = 1000
  ): Promise<void> {
    logger.info('Starting historical data backfill', {
      fromBlock,
      toBlock,
      totalBlocks: toBlock - fromBlock + 1,
      batchSize
    });

    const startTime = Date.now();
    let processedBlocks = 0;

    for (let currentBlock = fromBlock; currentBlock <= toBlock; currentBlock += batchSize) {
      const batchEnd = Math.min(currentBlock + batchSize - 1, toBlock);
      
      try {
        await this.processBatchBlocks(currentBlock, batchEnd);
        processedBlocks += (batchEnd - currentBlock + 1);
        
        const progress = ((processedBlocks / (toBlock - fromBlock + 1)) * 100).toFixed(2);
        logger.info('Backfill progress', {
          currentBlock: batchEnd,
          processedBlocks,
          totalBlocks: toBlock - fromBlock + 1,
          progress: `${progress}%`,
          estimatedTimeRemaining: this.estimateTimeRemaining(startTime, processedBlocks, toBlock - fromBlock + 1)
        });

        // Small delay to prevent overwhelming the database
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        logger.error('Backfill batch failed', {
          fromBlock: currentBlock,
          toBlock: batchEnd,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        
        // Continue with next batch instead of failing completely
        continue;
      }
    }

    await this.refreshMaterializedViews();

    const duration = Date.now() - startTime;
    logger.info('Historical data backfill completed', {
      fromBlock,
      toBlock,
      processedBlocks,
      duration,
      blocksPerSecond: Math.round(processedBlocks / (duration / 1000))
    });
  }

  /**
   * Estimate time remaining for backfill
   */
  private estimateTimeRemaining(startTime: number, processedBlocks: number, totalBlocks: number): string {
    const elapsedMs = Date.now() - startTime;
    const blocksPerMs = processedBlocks / elapsedMs;
    const remainingBlocks = totalBlocks - processedBlocks;
    const remainingMs = remainingBlocks / blocksPerMs;
    
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return `${remainingMinutes} minutes`;
  }
} 