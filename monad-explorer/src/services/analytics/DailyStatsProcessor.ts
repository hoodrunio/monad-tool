import { DataSource } from 'typeorm';
import { Transaction, Block, DailyStats } from '../../model/generated';
import { logger } from '../../utils/logger';

export interface DailyStatsComputationResult {
  date: Date;
  blockCount: number;
  transactionCount: number;
  uniqueAddresses: number;
  totalGasUsed: bigint;
  averageGasPrice: bigint;
  totalValue: bigint;
}

export interface DailyStatsProcessorConfig {
  batchSize: number;
  skipExisting: boolean;
  timeout: number;
}

/**
 * DailyStatsProcessor - Computes daily blockchain statistics
 * 
 * Features:
 * - Aggregates Transaction and Block data into daily statistics
 * - Handles unique address counting efficiently
 * - Computes gas price averages and totals
 * - Atomic updates with rollback support
 * - Idempotent operation (can safely rerun)
 */
export class DailyStatsProcessor {
  private readonly config: DailyStatsProcessorConfig = {
    batchSize: 1000, // Process 1000 transactions at a time
    skipExisting: true, // Skip already computed stats by default
    timeout: 300000, // 5 minutes timeout
  };

  constructor(
    private readonly dataSource: DataSource,
    config?: Partial<DailyStatsProcessorConfig>
  ) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Compute daily stats for a specific date
   */
  public async computeDailyStats(
    date: Date, 
    forceRecalculate: boolean = false
  ): Promise<DailyStatsComputationResult> {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const startTime = Date.now();
    
    logger.info('Starting daily stats computation', {
      date: dateStr,
      forceRecalculate,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });

    try {
      // Check if stats already exist (unless force recalculate)
      if (!forceRecalculate && this.config.skipExisting) {
        const existing = await this.getExistingStats(date);
        if (existing) {
          logger.info('Daily stats already exist, skipping', { date: dateStr });
          return this.mapEntityToResult(existing);
        }
      }

      // Calculate date range (start of day to end of day)
      const startOfDay = new Date(date);
      startOfDay.setUTCHours(0, 0, 0, 0);
      
      const endOfDay = new Date(date);
      endOfDay.setUTCHours(23, 59, 59, 999);

      // Compute stats from raw data with memory monitoring
      const result = await this.computeStatsFromTransactions(startOfDay, endOfDay);
      
      // Save to database
      await this.saveDailyStats(result);
      
      // Explicit cleanup to help garbage collection
      // Clear any large variables that might still be in scope
      if (global.gc) {
        global.gc();
      }
      
      const duration = Date.now() - startTime;
      const finalMemoryMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      
      logger.info('Daily stats computation completed', {
        date: dateStr,
        duration: `${duration}ms`,
        transactionCount: result.transactionCount,
        blockCount: result.blockCount,
        uniqueAddresses: result.uniqueAddresses,
        memoryUsageMB: finalMemoryMB
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMemoryMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      
      logger.error('Daily stats computation failed', {
        date: dateStr,
        duration: `${duration}ms`,
        memoryUsageMB: errorMemoryMB,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Force garbage collection after error to clean up any partial data
      if (global.gc) {
        global.gc();
      }
      
      throw error;
    }
  }

  /**
   * Compute daily stats for a date range (for backfilling)
   */
  public async computeDailyStatsRange(
    startDate: Date,
    endDate: Date,
    forceRecalculate: boolean = false
  ): Promise<DailyStatsComputationResult[]> {
    const results: DailyStatsComputationResult[] = [];
    const current = new Date(startDate);
    
    logger.info('Starting daily stats range computation', {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      forceRecalculate
    });

    while (current <= endDate) {
      try {
        const result = await this.computeDailyStats(current, forceRecalculate);
        results.push(result);
      } catch (error) {
        logger.error('Failed to compute daily stats for date', {
          date: current.toISOString().split('T')[0],
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        // Continue with next date instead of failing entire batch
      }
      
      // Move to next day
      current.setDate(current.getDate() + 1);
    }

    logger.info('Daily stats range computation completed', {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      processedDays: results.length
    });

    return results;
  }

  /**
   * Check if daily stats already exist for a date
   */
  private async getExistingStats(date: Date): Promise<DailyStats | null> {
    const dailyStatsRepo = this.dataSource.getRepository(DailyStats);
    
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setUTCHours(23, 59, 59, 999);

    return await dailyStatsRepo.findOne({
      where: {
        date: startOfDay // Daily stats uses start of day
      }
    });
  }

  /**
   * Compute statistics from Transaction and Block data
   * Optimized to prevent memory overflow by using database aggregations
   */
  private async computeStatsFromTransactions(
    startOfDay: Date,
    endOfDay: Date
  ): Promise<DailyStatsComputationResult> {
    const transactionRepo = this.dataSource.getRepository(Transaction);
    const blockRepo = this.dataSource.getRepository(Block);

    logger.debug('Computing stats from database aggregations', {
      startOfDay: startOfDay.toISOString(),
      endOfDay: endOfDay.toISOString(),
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });

    try {
      // Use database-level aggregations to avoid loading all data into memory
      // Execute queries sequentially to control memory usage instead of parallel execution
      
      // Get transaction count
      const transactionStats = await transactionRepo
        .createQueryBuilder('tx')
        .where('tx.timestamp >= :startOfDay', { startOfDay })
        .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
        .getCount();

      logger.debug('Transaction count completed', { 
        count: transactionStats,
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      });

      // Get block count
      const blockCount = await blockRepo
        .createQueryBuilder('block')
        .where('block.timestamp >= :startOfDay', { startOfDay })
        .andWhere('block.timestamp <= :endOfDay', { endOfDay })
        .getCount();

      logger.debug('Block count completed', { 
        count: blockCount,
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      });

      // Get unique address count using optimized method
      const uniqueAddressCount = await this.getUniqueAddressCount(startOfDay, endOfDay);

      logger.debug('Unique address count completed', { 
        count: uniqueAddressCount,
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      });

      // Get gas statistics using database aggregation
      const gasStats = await this.getGasStatistics(startOfDay, endOfDay);

      logger.debug('Gas statistics completed', { 
        totalGasUsed: gasStats.totalGasUsed.toString(),
        averageGasPrice: gasStats.averageGasPrice.toString(),
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      });

      // Get total value transferred using database aggregation
      const totalValueResult = await transactionRepo
        .createQueryBuilder('tx')
        .select('COALESCE(SUM(tx.value), 0)', 'totalValue')
        .where('tx.timestamp >= :startOfDay', { startOfDay })
        .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
        .getRawOne();
      
      const totalValue = BigInt(totalValueResult?.totalValue || '0');

      logger.debug('Total value computation completed', { 
        totalValue: totalValue.toString(),
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      });

      // Create result object
      const result: DailyStatsComputationResult = {
        date: startOfDay,
        blockCount,
        transactionCount: transactionStats,
        uniqueAddresses: uniqueAddressCount,
        totalGasUsed: gasStats.totalGasUsed,
        averageGasPrice: gasStats.averageGasPrice,
        totalValue
      };

      logger.debug('Stats computation result prepared', {
        date: startOfDay.toISOString().split('T')[0],
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      });

      return result;

    } catch (error) {
      logger.error('Error in computeStatsFromTransactions', {
        startOfDay: startOfDay.toISOString(),
        endOfDay: endOfDay.toISOString(),
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Get unique address count using database aggregation
   * Optimized to handle large datasets by using COUNT(DISTINCT) instead of loading all data into memory
   */
  private async getUniqueAddressCount(startOfDay: Date, endOfDay: Date): Promise<number> {
    const transactionRepo = this.dataSource.getRepository(Transaction);
    
    // Get transaction count first to decide on strategy
    const totalTransactions = await transactionRepo
      .createQueryBuilder('tx')
      .where('tx.timestamp >= :startOfDay', { startOfDay })
      .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
      .getCount();
    
    if (totalTransactions === 0) {
      return 0;
    }
    
    // For very large datasets, use pure SQL with COUNT(DISTINCT) for maximum memory efficiency
    if (totalTransactions > 100000) {
      return await this.getUniqueAddressCountPureSQL(startOfDay, endOfDay);
    }
    
    // For medium datasets, use database-level DISTINCT counting
    if (totalTransactions > 10000) {
      return await this.getUniqueAddressCountOptimized(startOfDay, endOfDay);
    }
    
    // For small datasets, use the simple approach
    return await this.getUniqueAddressCountSimple(startOfDay, endOfDay);
  }
  
  /**
   * Pure SQL approach for maximum memory efficiency (for very large datasets)
   */
  private async getUniqueAddressCountPureSQL(startOfDay: Date, endOfDay: Date): Promise<number> {
    const result = await this.dataSource.query(`
      WITH unique_addresses AS (
        SELECT DISTINCT LOWER(from_address) as address
        FROM transaction 
        WHERE timestamp >= $1 AND timestamp <= $2 
          AND from_address IS NOT NULL
        UNION
        SELECT DISTINCT LOWER(to_address) as address
        FROM transaction 
        WHERE timestamp >= $3 AND timestamp <= $4 
          AND to_address IS NOT NULL
      )
      SELECT COUNT(*) as count FROM unique_addresses
    `, [startOfDay, endOfDay, startOfDay, endOfDay]);
    
    return parseInt(result[0]?.count || '0', 10);
  }
  
  /**
   * Optimized unique address counting using database aggregations (for medium datasets)
   */
  private async getUniqueAddressCountOptimized(startOfDay: Date, endOfDay: Date): Promise<number> {
    const transactionRepo = this.dataSource.getRepository(Transaction);
    
    // Use separate COUNT(DISTINCT) queries for from and to addresses, then combine
    const [fromCount, toCount, bothCount] = await Promise.all([
      // Count unique from addresses
      transactionRepo
        .createQueryBuilder('tx')
        .select('COUNT(DISTINCT LOWER(tx.from_address))', 'count')
        .where('tx.timestamp >= :startOfDay', { startOfDay })
        .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
        .andWhere('tx.from_address IS NOT NULL')
        .getRawOne()
        .then(result => parseInt(result?.count || '0', 10)),
      
      // Count unique to addresses
      transactionRepo
        .createQueryBuilder('tx')
        .select('COUNT(DISTINCT LOWER(tx.to_address))', 'count')
        .where('tx.timestamp >= :startOfDay', { startOfDay })
        .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
        .andWhere('tx.to_address IS NOT NULL')
        .getRawOne()
        .then(result => parseInt(result?.count || '0', 10)),
      
      // Count addresses that appear in both from and to (to avoid double counting)
      this.dataSource.query(`
        SELECT COUNT(DISTINCT addr) as count FROM (
          SELECT DISTINCT LOWER(from_address) as addr
          FROM transaction 
          WHERE timestamp >= $1 AND timestamp <= $2 
            AND from_address IS NOT NULL
          INTERSECT
          SELECT DISTINCT LOWER(to_address) as addr
          FROM transaction 
          WHERE timestamp >= $3 AND timestamp <= $4 
            AND to_address IS NOT NULL
        ) intersection
      `, [startOfDay, endOfDay, startOfDay, endOfDay])
        .then(result => parseInt(result[0]?.count || '0', 10))
    ]);
    
    // Total unique = from_unique + to_unique - intersection
    return fromCount + toCount - bothCount;
  }
  
  /**
   * Simple unique address counting for smaller datasets
   */
  private async getUniqueAddressCountSimple(startOfDay: Date, endOfDay: Date): Promise<number> {
    const transactionRepo = this.dataSource.getRepository(Transaction);
    
    // For small datasets, we can safely load distinct addresses
    const [fromAddresses, toAddresses] = await Promise.all([
      // Get unique from addresses
      transactionRepo
        .createQueryBuilder('tx')
        .select('DISTINCT LOWER(tx.from_address)', 'address')
        .where('tx.timestamp >= :startOfDay', { startOfDay })
        .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
        .andWhere('tx.from_address IS NOT NULL')
        .getRawMany(),
      
      // Get unique to addresses
      transactionRepo
        .createQueryBuilder('tx')
        .select('DISTINCT LOWER(tx.to_address)', 'address')
        .where('tx.timestamp >= :startOfDay', { startOfDay })
        .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
        .andWhere('tx.to_address IS NOT NULL')
        .getRawMany()
    ]);

    // Combine and count unique addresses
    const uniqueAddresses = new Set<string>();
    
    fromAddresses.forEach(row => {
      if (row.address) {
        uniqueAddresses.add(row.address);
      }
    });
    
    toAddresses.forEach(row => {
      if (row.address) {
        uniqueAddresses.add(row.address);
      }
    });

    return uniqueAddresses.size;
  }

  /**
   * Get gas statistics using database aggregation
   */
  private async getGasStatistics(startOfDay: Date, endOfDay: Date): Promise<{
    totalGasUsed: bigint;
    averageGasPrice: bigint;
  }> {
    const transactionRepo = this.dataSource.getRepository(Transaction);
    
    // Get gas statistics for successful transactions only
    const result = await transactionRepo
      .createQueryBuilder('tx')
      .select([
        'COALESCE(SUM(tx.gas_used), 0) as totalGasUsed',
        'COALESCE(SUM(CASE WHEN tx.effective_gas_price > 0 THEN tx.effective_gas_price ELSE tx.gas_price END), 0) as totalGasPrice',
        'COUNT(CASE WHEN COALESCE(tx.effective_gas_price, tx.gas_price) > 0 THEN 1 END) as validGasPriceCount'
      ])
      .where('tx.timestamp >= :startOfDay', { startOfDay })
      .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
      .andWhere('tx.status = 1') // Only successful transactions
      .getRawOne();

    const totalGasUsed = BigInt(result?.totalGasUsed || '0');
    const totalGasPrice = BigInt(result?.totalGasPrice || '0');
    const validGasPriceCount = parseInt(result?.validGasPriceCount || '0', 10);

    const averageGasPrice = validGasPriceCount > 0 
      ? totalGasPrice / BigInt(validGasPriceCount)
      : BigInt(0);

    return {
      totalGasUsed,
      averageGasPrice
    };
  }

  /**
   * Save computed daily stats to database
   */
  private async saveDailyStats(result: DailyStatsComputationResult): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      logger.debug('Saving daily stats to database', {
        date: result.date.toISOString().split('T')[0],
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      });

      const dailyStatsRepo = queryRunner.manager.getRepository(DailyStats);
      
      // Create DailyStats entity
      const dailyStats = new DailyStats({
        id: result.date.toISOString().split('T')[0], // YYYY-MM-DD format
        date: result.date,
        blockCount: result.blockCount,
        transactionCount: result.transactionCount,
        uniqueAddresses: result.uniqueAddresses,
        totalGasUsed: result.totalGasUsed,
        averageGasPrice: result.averageGasPrice,
        totalValue: result.totalValue
      });

      // Use upsert to handle duplicates
      await dailyStatsRepo.save(dailyStats);
      
      await queryRunner.commitTransaction();
      
      logger.debug('Daily stats saved to database successfully', {
        date: result.date.toISOString().split('T')[0],
        stats: {
          blockCount: result.blockCount,
          transactionCount: result.transactionCount,
          uniqueAddresses: result.uniqueAddresses,
          totalGasUsed: result.totalGasUsed.toString(),
          averageGasPrice: result.averageGasPrice.toString(),
          totalValue: result.totalValue.toString()
        },
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      });

    } catch (error) {
      // Ensure transaction is rolled back on error
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      
      logger.error('Failed to save daily stats to database', {
        date: result.date.toISOString().split('T')[0],
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    } finally {
      // Always ensure the query runner is released to prevent connection leaks
      if (queryRunner && !queryRunner.isReleased) {
        await queryRunner.release();
      }
      
      // Force garbage collection to clean up any large objects
      if (global.gc) {
        global.gc();
      }
    }
  }

  /**
   * Map DailyStats entity to computation result
   */
  private mapEntityToResult(entity: DailyStats): DailyStatsComputationResult {
    return {
      date: entity.date,
      blockCount: entity.blockCount,
      transactionCount: entity.transactionCount,
      uniqueAddresses: entity.uniqueAddresses,
      totalGasUsed: entity.totalGasUsed,
      averageGasPrice: entity.averageGasPrice,
      totalValue: entity.totalValue
    };
  }

  /**
   * Get processor statistics
   */
  public getStats(): {
    batchSize: number;
    skipExisting: boolean;
    timeout: number;
  } {
    return { ...this.config };
  }
} 