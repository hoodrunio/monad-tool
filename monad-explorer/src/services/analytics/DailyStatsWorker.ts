import { IQueueService, DailyStatsMessage } from '../../interfaces/services/IQueueService';
import { DailyStatsProcessor, DailyStatsProcessorConfig } from './DailyStatsProcessor';
import { logger } from '../../utils/logger';
import { DataSource } from 'typeorm';

export interface DailyStatsWorkerConfig {
  concurrency: number;
  retryAttempts: number;
  retryDelay: number;
  batchSize: number;
  processingTimeout: number;
}

/**
 * Background worker for processing daily statistics computation messages
 * Consumes from RabbitMQ queue and computes daily blockchain statistics
 * Updates DailyStats table with aggregated data
 */
export class DailyStatsWorker {
  private isRunning = false;
  private processedCount = 0;
  private errorCount = 0;
  private startTime?: Date;

  private readonly config: DailyStatsWorkerConfig = {
    concurrency: 2, // Lower concurrency for intensive computation
    retryAttempts: 3,
    retryDelay: 5000, // 5 seconds
    batchSize: 3, // Small batch for daily computation
    processingTimeout: 600000, // 10 minutes for daily computation
  };

  private readonly processor: DailyStatsProcessor;

  constructor(
    private readonly queueService: IQueueService,
    private readonly dataSource: DataSource,
    config?: Partial<DailyStatsWorkerConfig>,
    processorConfig?: Partial<DailyStatsProcessorConfig>
  ) {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // Initialize processor with database connection
    this.processor = new DailyStatsProcessor(this.dataSource, processorConfig);
  }

  /**
   * Start the worker
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Daily stats worker is already running');
      return;
    }

    if (!this.queueService.isConnected()) {
      throw new Error('Queue service is not connected');
    }

    if (!this.dataSource.isInitialized) {
      throw new Error('Database connection is not initialized');
    }

    this.isRunning = true;
    this.startTime = new Date();
    this.processedCount = 0;
    this.errorCount = 0;

    logger.info('Starting daily stats worker', {
      concurrency: this.config.concurrency,
      batchSize: this.config.batchSize,
      timeout: this.config.processingTimeout,
    });

    try {
      await this.queueService.consumeDailyStats(
        this.processDailyStatsMessage.bind(this),
        {
          concurrency: this.config.concurrency,
          prefetch: this.config.batchSize,
          autoAck: false,
        }
      );

      logger.info('Daily stats worker started successfully');
    } catch (error) {
      this.isRunning = false;
      logger.error('Failed to start daily stats worker', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Stop the worker
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Daily stats worker is not running');
      return;
    }

    this.isRunning = false;
    logger.info('Stopping daily stats worker...');

    const duration = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    logger.info('Daily stats worker stopped', {
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      duration: `${Math.round(duration / 1000)}s`,
    });
  }

  /**
   * Get worker statistics
   */
  public getStats(): {
    isRunning: boolean;
    processedCount: number;
    errorCount: number;
    uptime: number;
    processingRate: number;
  } {
    const uptime = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const processingRate = uptime > 0 ? (this.processedCount / (uptime / 1000)) : 0;

    return {
      isRunning: this.isRunning,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      uptime,
      processingRate,
    };
  }

  /**
   * Process a single daily stats computation message
   */
  private async processDailyStatsMessage(message: DailyStatsMessage): Promise<void> {
    const startTime = Date.now();
    
    try {
      if (message.startDate && message.endDate) {
        // Batch processing for date range
        await this.processBatchMessage(message);
      } else {
        // Single date processing
        await this.processSingleDateMessage(message);
      }

      this.processedCount++;
      
      const duration = Date.now() - startTime;
      logger.debug('Daily stats message processed successfully', {
        date: message.date,
        duration: `${duration}ms`,
        batchProcessing: !!(message.startDate && message.endDate)
      });

    } catch (error) {
      this.errorCount++;
      const duration = Date.now() - startTime;
      
      logger.error('Error processing daily stats message', {
        date: message.date,
        startDate: message.startDate,
        endDate: message.endDate,
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Process single date message
   */
  private async processSingleDateMessage(message: DailyStatsMessage): Promise<void> {
    const date = new Date(message.date);
    const forceRecalculate = message.forceRecalculate || false;

    logger.info('Processing daily stats for single date', {
      date: message.date,
      forceRecalculate
    });

    const result = await this.processor.computeDailyStats(date, forceRecalculate);

    logger.info('Daily stats computed successfully', {
      date: message.date,
      transactionCount: result.transactionCount,
      blockCount: result.blockCount,
      uniqueAddresses: result.uniqueAddresses,
      totalGasUsed: result.totalGasUsed.toString(),
      averageGasPrice: result.averageGasPrice.toString()
    });
  }

  /**
   * Process batch message for date range
   */
  private async processBatchMessage(message: DailyStatsMessage): Promise<void> {
    if (!message.startDate || !message.endDate) {
      throw new Error('Batch processing requires both startDate and endDate');
    }

    const startDate = new Date(message.startDate);
    const endDate = new Date(message.endDate);
    const forceRecalculate = message.forceRecalculate || false;

    logger.info('Processing daily stats for date range', {
      startDate: message.startDate,
      endDate: message.endDate,
      forceRecalculate
    });

    const results = await this.processor.computeDailyStatsRange(
      startDate,
      endDate,
      forceRecalculate
    );

    logger.info('Daily stats batch processing completed', {
      startDate: message.startDate,
      endDate: message.endDate,
      processedDays: results.length,
      totalTransactions: results.reduce((sum, r) => sum + r.transactionCount, 0),
      totalBlocks: results.reduce((sum, r) => sum + r.blockCount, 0)
    });
  }

  /**
   * Trigger daily stats computation for today
   */
  public async triggerTodayComputation(forceRecalculate: boolean = false): Promise<void> {
    if (!this.queueService.isConnected()) {
      throw new Error('Queue service is not connected');
    }

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    const message: DailyStatsMessage = {
      date: dateStr,
      forceRecalculate
    };

    await this.queueService.publishDailyStats(message, {
      priority: 8 // High priority for today's computation
    });

    logger.info('Triggered daily stats computation for today', {
      date: dateStr,
      forceRecalculate
    });
  }

  /**
   * Trigger daily stats computation for yesterday (most common use case)
   */
  public async triggerYesterdayComputation(forceRecalculate: boolean = false): Promise<void> {
    if (!this.queueService.isConnected()) {
      throw new Error('Queue service is not connected');
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    const message: DailyStatsMessage = {
      date: dateStr,
      forceRecalculate
    };

    await this.queueService.publishDailyStats(message, {
      priority: 9 // Highest priority for yesterday's computation
    });

    logger.info('Triggered daily stats computation for yesterday', {
      date: dateStr,
      forceRecalculate
    });
  }

  /**
   * Trigger batch computation for date range (for backfilling)
   */
  public async triggerBatchComputation(
    startDate: Date,
    endDate: Date,
    forceRecalculate: boolean = false
  ): Promise<void> {
    if (!this.queueService.isConnected()) {
      throw new Error('Queue service is not connected');
    }

    const message: DailyStatsMessage = {
      date: startDate.toISOString().split('T')[0], // Primary date for message ID
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      forceRecalculate
    };

    await this.queueService.publishDailyStats(message, {
      priority: 5 // Normal priority for batch processing
    });

    logger.info('Triggered daily stats batch computation', {
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      forceRecalculate
    });
  }
} 