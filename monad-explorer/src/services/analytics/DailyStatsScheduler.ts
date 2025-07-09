import { DailyStatsWorker } from './DailyStatsWorker';
import { logger } from '../../utils/logger';

export interface DailyStatsSchedulerConfig {
  cronSchedule: string; // Cron expression for scheduling
  enableAutoTrigger: boolean;
  retryAttempts: number;
  retryDelay: number;
  maxHistoryDays: number; // Maximum days to backfill if missing
}

/**
 * DailyStatsScheduler - Manages automated daily statistics computation
 * 
 * Features:
 * - Cron-based scheduling for daily execution
 * - Automatic triggering of yesterday's stats computation
 * - Backfill missing dates
 * - Error handling with retry logic
 * - Health monitoring
 */
export class DailyStatsScheduler {
  private isRunning = false;
  private scheduledJobs: NodeJS.Timeout[] = [];
  private lastExecutionTime?: Date;
  private lastExecutionStatus: 'success' | 'failed' | 'pending' = 'pending';
  private executionCount = 0;
  private errorCount = 0;
  
  private readonly config: DailyStatsSchedulerConfig = {
    cronSchedule: '0 2 * * *', // Daily at 2:00 AM UTC
    enableAutoTrigger: true,
    retryAttempts: 3,
    retryDelay: 300000, // 5 minutes
    maxHistoryDays: 7, // Backfill up to 7 days if missing
  };

  constructor(
    private readonly dailyStatsWorker: DailyStatsWorker,
    config?: Partial<DailyStatsSchedulerConfig>
  ) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Start the scheduler
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Daily stats scheduler is already running');
      return;
    }

    if (!this.config.enableAutoTrigger) {
      logger.info('Daily stats scheduler is disabled');
      return;
    }

    this.isRunning = true;
    this.executionCount = 0;
    this.errorCount = 0;

    logger.info('Starting daily stats scheduler', {
      cronSchedule: this.config.cronSchedule,
      maxHistoryDays: this.config.maxHistoryDays,
      retryAttempts: this.config.retryAttempts
    });

    // Start periodic execution
    this.schedulePeriodicExecution();

    // Optionally run initial check for missing stats
    if (this.config.maxHistoryDays > 0) {
      setTimeout(() => {
        this.checkAndBackfillMissingStats();
      }, 30000); // Wait 30 seconds after startup
    }

    logger.info('Daily stats scheduler started successfully');
  }

  /**
   * Stop the scheduler
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Daily stats scheduler is not running');
      return;
    }

    this.isRunning = false;

    // Clear all scheduled jobs
    this.scheduledJobs.forEach(job => {
      clearTimeout(job);
    });
    this.scheduledJobs = [];

    logger.info('Daily stats scheduler stopped', {
      executionCount: this.executionCount,
      errorCount: this.errorCount,
      lastExecutionTime: this.lastExecutionTime,
      lastExecutionStatus: this.lastExecutionStatus
    });
  }

  /**
   * Manually trigger daily stats computation for a specific date
   */
  public async triggerManualComputation(
    date: Date,
    forceRecalculate: boolean = false
  ): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Scheduler is not running');
    }

    const dateStr = date.toISOString().split('T')[0];
    
    logger.info('Manually triggering daily stats computation', {
      date: dateStr,
      forceRecalculate
    });

    try {
      await this.dailyStatsWorker.triggerBatchComputation(
        date,
        date,
        forceRecalculate
      );

      logger.info('Manual daily stats computation triggered successfully', {
        date: dateStr
      });

    } catch (error) {
      logger.error('Failed to trigger manual daily stats computation', {
        date: dateStr,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Get scheduler statistics
   */
  public getStats(): {
    isRunning: boolean;
    executionCount: number;
    errorCount: number;
    lastExecutionTime?: Date;
    lastExecutionStatus: string;
    nextExecutionEstimate?: Date;
    config: DailyStatsSchedulerConfig;
  } {
    return {
      isRunning: this.isRunning,
      executionCount: this.executionCount,
      errorCount: this.errorCount,
      lastExecutionTime: this.lastExecutionTime,
      lastExecutionStatus: this.lastExecutionStatus,
      nextExecutionEstimate: this.calculateNextExecution(),
      config: this.config
    };
  }

  /**
   * Schedule periodic execution based on cron schedule
   */
  private schedulePeriodicExecution(): void {
    // Simple cron parser for daily schedule (hour:minute format)
    const cronParts = this.config.cronSchedule.split(' ');
    if (cronParts.length !== 5) {
      logger.error('Invalid cron schedule format', { schedule: this.config.cronSchedule });
      return;
    }

    const [minute, hour] = cronParts;
    const targetHour = parseInt(hour, 10);
    const targetMinute = parseInt(minute, 10);

    if (isNaN(targetHour) || isNaN(targetMinute)) {
      logger.error('Invalid cron schedule values', { hour, minute });
      return;
    }

    // Schedule daily execution
    const scheduleDaily = () => {
      const now = new Date();
      const target = new Date();
      target.setUTCHours(targetHour, targetMinute, 0, 0);

      // If target time has passed today, schedule for tomorrow
      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }

      const timeUntilExecution = target.getTime() - now.getTime();

      logger.info('Scheduling next daily stats execution', {
        targetTime: target.toISOString(),
        timeUntilExecution: `${Math.round(timeUntilExecution / 1000 / 60)} minutes`
      });

      const job = setTimeout(async () => {
        await this.executeScheduledTask();
        scheduleDaily(); // Schedule next execution
      }, timeUntilExecution);

      this.scheduledJobs.push(job);
    };

    scheduleDaily();
  }

  /**
   * Execute the scheduled daily stats computation
   */
  private async executeScheduledTask(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.lastExecutionTime = new Date();
    this.lastExecutionStatus = 'pending';
    this.executionCount++;

    logger.info('Executing scheduled daily stats computation', {
      executionNumber: this.executionCount,
      scheduledTime: this.lastExecutionTime.toISOString()
    });

    try {
      // Trigger computation for yesterday's data
      await this.dailyStatsWorker.triggerYesterdayComputation(false);

      this.lastExecutionStatus = 'success';
      
      logger.info('Scheduled daily stats computation completed successfully', {
        executionNumber: this.executionCount,
        completedAt: new Date().toISOString()
      });

    } catch (error) {
      this.errorCount++;
      this.lastExecutionStatus = 'failed';
      
      logger.error('Scheduled daily stats computation failed', {
        executionNumber: this.executionCount,
        error: error instanceof Error ? error.message : 'Unknown error',
        retryAttempts: this.config.retryAttempts
      });

      // Implement retry logic
      await this.retryExecution();
    }
  }

  /**
   * Retry failed execution with exponential backoff
   */
  private async retryExecution(): Promise<void> {
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      if (!this.isRunning) {
        return;
      }

      const delay = this.config.retryDelay * Math.pow(2, attempt - 1);
      
      logger.info('Retrying daily stats computation', {
        attempt,
        maxAttempts: this.config.retryAttempts,
        delay: `${delay / 1000}s`
      });

      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        await this.dailyStatsWorker.triggerYesterdayComputation(false);
        
        this.lastExecutionStatus = 'success';
        logger.info('Daily stats computation retry succeeded', { attempt });
        return;

      } catch (error) {
        logger.error('Daily stats computation retry failed', {
          attempt,
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        if (attempt === this.config.retryAttempts) {
          logger.error('All retry attempts exhausted', {
            totalAttempts: this.config.retryAttempts
          });
        }
      }
    }
  }

  /**
   * Check for missing daily stats and backfill if needed
   */
  private async checkAndBackfillMissingStats(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Checking for missing daily stats', {
      maxHistoryDays: this.config.maxHistoryDays
    });

    try {
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1); // Yesterday

      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - this.config.maxHistoryDays);

      // Trigger batch computation for the range
      // The DailyStatsProcessor will skip existing entries
      await this.dailyStatsWorker.triggerBatchComputation(
        startDate,
        endDate,
        false // Don't force recalculate
      );

      logger.info('Missing stats backfill initiated', {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0]
      });

    } catch (error) {
      logger.error('Failed to initiate missing stats backfill', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Calculate next execution time based on cron schedule
   */
  private calculateNextExecution(): Date | undefined {
    if (!this.config.cronSchedule) {
      return undefined;
    }

    const cronParts = this.config.cronSchedule.split(' ');
    if (cronParts.length !== 5) {
      return undefined;
    }

    const [minute, hour] = cronParts;
    const targetHour = parseInt(hour, 10);
    const targetMinute = parseInt(minute, 10);

    if (isNaN(targetHour) || isNaN(targetMinute)) {
      return undefined;
    }

    const now = new Date();
    const target = new Date();
    target.setUTCHours(targetHour, targetMinute, 0, 0);

    // If target time has passed today, schedule for tomorrow
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    return target;
  }
} 