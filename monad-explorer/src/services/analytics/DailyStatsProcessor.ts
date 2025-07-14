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
      forceRecalculate
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

      // Compute stats from raw data
      const result = await this.computeStatsFromTransactions(startOfDay, endOfDay);
      
      // Save to database
      await this.saveDailyStats(result);
      
      const duration = Date.now() - startTime;
      logger.info('Daily stats computation completed', {
        date: dateStr,
        duration: `${duration}ms`,
        transactionCount: result.transactionCount,
        blockCount: result.blockCount,
        uniqueAddresses: result.uniqueAddresses
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Daily stats computation failed', {
        date: dateStr,
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
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

    // Use database-level aggregations to avoid loading all data into memory
    const [transactionStats, blockCount, uniqueAddressCount, gasStats, totalValue] = await Promise.all([
      // Get transaction count
      transactionRepo
        .createQueryBuilder('tx')
        .where('tx.timestamp >= :startOfDay', { startOfDay })
        .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
        .getCount(),

      // Get block count
      blockRepo
        .createQueryBuilder('block')
        .where('block.timestamp >= :startOfDay', { startOfDay })
        .andWhere('block.timestamp <= :endOfDay', { endOfDay })
        .getCount(),

      // Get unique address count using database aggregation
      this.getUniqueAddressCount(startOfDay, endOfDay),

      // Get gas statistics using database aggregation
      this.getGasStatistics(startOfDay, endOfDay),

      // Get total value transferred using database aggregation
      transactionRepo
        .createQueryBuilder('tx')
        .select('COALESCE(SUM(tx.value), 0)', 'totalValue')
        .where('tx.timestamp >= :startOfDay', { startOfDay })
        .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
        .getRawOne()
        .then(result => BigInt(result?.totalValue || '0'))
    ]);

    return {
      date: startOfDay,
      blockCount,
      transactionCount: transactionStats,
      uniqueAddresses: uniqueAddressCount,
      totalGasUsed: gasStats.totalGasUsed,
      averageGasPrice: gasStats.averageGasPrice,
      totalValue
    };
  }

    /**
   * Get unique address count using database aggregation
   * Optimized to handle large datasets by processing in chunks
   */
   private async getUniqueAddressCount(startOfDay: Date, endOfDay: Date): Promise<number> {
     const transactionRepo = this.dataSource.getRepository(Transaction);
     const chunkSize = 10000; // Process 10k transactions at a time
     
     // Get total transaction count for the day
     const totalTransactions = await transactionRepo
       .createQueryBuilder('tx')
       .where('tx.timestamp >= :startOfDay', { startOfDay })
       .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
       .getCount();
     
     if (totalTransactions === 0) {
       return 0;
     }
     
     // If we have a reasonable number of transactions, use the simple approach
     if (totalTransactions <= 50000) {
       return await this.getUniqueAddressCountSimple(startOfDay, endOfDay);
     }
     
     // For large datasets, use chunked processing
     return await this.getUniqueAddressCountChunked(startOfDay, endOfDay, chunkSize);
   }
   
   /**
    * Simple unique address counting for smaller datasets
    */
   private async getUniqueAddressCountSimple(startOfDay: Date, endOfDay: Date): Promise<number> {
     const transactionRepo = this.dataSource.getRepository(Transaction);
     
     // Get unique addresses from both from and to addresses using separate queries
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
    * Chunked unique address counting for large datasets
    */
   private async getUniqueAddressCountChunked(startOfDay: Date, endOfDay: Date, chunkSize: number): Promise<number> {
     const transactionRepo = this.dataSource.getRepository(Transaction);
     const uniqueAddresses = new Set<string>();
     
     // Get all transaction IDs for the day to process in chunks
     const transactionIds = await transactionRepo
       .createQueryBuilder('tx')
       .select('tx.id')
       .where('tx.timestamp >= :startOfDay', { startOfDay })
       .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
       .orderBy('tx.id')
       .getMany();
     
     // Process in chunks
     for (let i = 0; i < transactionIds.length; i += chunkSize) {
       const chunk = transactionIds.slice(i, i + chunkSize);
       const chunkIds = chunk.map(tx => tx.id);
       
       // Get addresses for this chunk
       const chunkTransactions = await transactionRepo
         .createQueryBuilder('tx')
         .select(['tx.from_address', 'tx.to_address'])
         .whereInIds(chunkIds)
         .getMany();
       
       // Add addresses to set
       chunkTransactions.forEach(tx => {
         if (tx.fromAddress) {
           uniqueAddresses.add(tx.fromAddress.toLowerCase());
         }
         if (tx.toAddress) {
           uniqueAddresses.add(tx.toAddress.toLowerCase());
         }
       });
       
       // Force garbage collection every few chunks
       if (i % (chunkSize * 5) === 0 && global.gc) {
         global.gc();
       }
     }
     
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
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
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
      
      logger.debug('Daily stats saved to database', {
        date: result.date.toISOString().split('T')[0],
        stats: {
          blockCount: result.blockCount,
          transactionCount: result.transactionCount,
          uniqueAddresses: result.uniqueAddresses,
          totalGasUsed: result.totalGasUsed.toString(),
          averageGasPrice: result.averageGasPrice.toString(),
          totalValue: result.totalValue.toString()
        }
      });

    } catch (error) {
      await queryRunner.rollbackTransaction();
      logger.error('Failed to save daily stats to database', {
        date: result.date.toISOString().split('T')[0],
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    } finally {
      await queryRunner.release();
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