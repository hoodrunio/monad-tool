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
   */
  private async computeStatsFromTransactions(
    startOfDay: Date,
    endOfDay: Date
  ): Promise<DailyStatsComputationResult> {
    const transactionRepo = this.dataSource.getRepository(Transaction);
    const blockRepo = this.dataSource.getRepository(Block);

    // Get all transactions for the day
    const transactions = await transactionRepo
      .createQueryBuilder('tx')
      .leftJoinAndSelect('tx.block', 'block')
      .where('tx.timestamp >= :startOfDay', { startOfDay })
      .andWhere('tx.timestamp <= :endOfDay', { endOfDay })
      .getMany();

    // Get all blocks for the day
    const blocks = await blockRepo
      .createQueryBuilder('block')
      .where('block.timestamp >= :startOfDay', { startOfDay })
      .andWhere('block.timestamp <= :endOfDay', { endOfDay })
      .getMany();

    // Compute aggregations
    const transactionCount = transactions.length;
    const blockCount = blocks.length;

    // Calculate unique addresses (from + to addresses)
    const uniqueAddresses = new Set<string>();
    transactions.forEach(tx => {
      uniqueAddresses.add(tx.fromAddress.toLowerCase());
      if (tx.toAddress) {
        uniqueAddresses.add(tx.toAddress.toLowerCase());
      }
    });

    // Calculate gas statistics (only successful transactions)
    const successfulTxs = transactions.filter(tx => tx.status === 1);
    
    let totalGasUsed = BigInt(0);
    let totalGasPrice = BigInt(0);
    let validGasPriceCount = 0;

    successfulTxs.forEach(tx => {
      if (tx.gasUsed) {
        totalGasUsed += tx.gasUsed;
      }
      
      const gasPrice = tx.effectiveGasPrice || tx.gasPrice;
      if (gasPrice && gasPrice > 0) {
        totalGasPrice += gasPrice;
        validGasPriceCount++;
      }
    });

    const averageGasPrice = validGasPriceCount > 0 
      ? totalGasPrice / BigInt(validGasPriceCount)
      : BigInt(0);

    // Calculate total value transferred
    const totalValue = transactions.reduce((sum, tx) => {
      return sum + (tx.value || BigInt(0));
    }, BigInt(0));

    return {
      date: startOfDay,
      blockCount,
      transactionCount,
      uniqueAddresses: uniqueAddresses.size,
      totalGasUsed,
      averageGasPrice,
      totalValue
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