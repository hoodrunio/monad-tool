// Monad Validator Analytics - Table Optimizer Service
// Periodic background job to optimize ClickHouse tables and prevent duplicate accumulation

import * as cron from 'node-cron';
import { logger } from '../utils/logger';
import { MonadClickHouseClient } from '../database/clickhouse-client';

export class TableOptimizerService {
  private client: MonadClickHouseClient;
  private task: cron.ScheduledTask | null = null;
  private isOptimizing = false;

  constructor(client: MonadClickHouseClient) {
    this.client = client;
  }

  /**
   * Start the periodic table optimization job
   * Runs every 10 minutes to merge duplicates in ReplacingMergeTree tables
   */
  start(): void {
    if (this.task) {
      logger.warn('Table optimizer is already running');
      return;
    }

    // Run every 10 minutes
    this.task = cron.schedule('*/10 * * * *', async () => {
      await this.optimizeTables();
    });

    logger.info('📊 Table optimizer service started (runs every 10 minutes)');

    // Run immediately on startup
    setTimeout(() => {
      this.optimizeTables();
    }, 5000); // Wait 5 seconds after startup
  }

  /**
   * Stop the periodic optimization job
   */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Table optimizer service stopped');
    }
  }

  /**
   * Optimize validator registry tables to merge duplicates
   */
  private async optimizeTables(): Promise<void> {
    if (this.isOptimizing) {
      logger.debug('Table optimization already in progress, skipping...');
      return;
    }

    this.isOptimizing = true;

    try {
      logger.debug('🔧 Starting table optimization...');

      // Optimize validator_registry table
      await this.client.executeCommand('OPTIMIZE TABLE validator_registry FINAL');
      logger.debug('✅ Optimized validator_registry');

      // Optimize validator_registry_latest table
      await this.client.executeCommand('OPTIMIZE TABLE validator_registry_latest FINAL');
      logger.debug('✅ Optimized validator_registry_latest');

      logger.info('✨ Table optimization completed successfully');
    } catch (error) {
      logger.error('❌ Failed to optimize tables:', error);
    } finally {
      this.isOptimizing = false;
    }
  }

  /**
   * Manually trigger table optimization
   */
  async optimizeNow(): Promise<void> {
    logger.info('Manual table optimization triggered');
    await this.optimizeTables();
  }
}
