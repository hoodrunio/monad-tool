#!/usr/bin/env tsx

// Increase Node.js heap size to prevent memory issues
// This script processes large datasets and may need more memory
if (process.env.NODE_OPTIONS && !process.env.NODE_OPTIONS.includes('--max-old-space-size')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS} --max-old-space-size=8192`;
} else if (!process.env.NODE_OPTIONS) {
  process.env.NODE_OPTIONS = '--max-old-space-size=8192';
}

import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { Transaction, Block, DailyStats } from '../src/model/generated';
import { DailyStatsProcessor } from '../src/services/analytics/DailyStatsProcessor';
import { logger } from '../src/utils/logger';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration
 */
interface BackfillConfig {
  // Date range
  startDate: string; // YYYY-MM-DD format
  endDate: string;   // YYYY-MM-DD format
  
  // Processing options
  concurrency: number;
  batchSize: number;
  forceRecalculate: boolean;
  skipExisting: boolean;
  enableGc: boolean; // Enable garbage collection
  
  // Database connection
  databaseUrl: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: BackfillConfig = {
  startDate: '2024-01-01',
  endDate: new Date().toISOString().split('T')[0], // Today
  concurrency: 2, // Reduced concurrency for better memory management
  batchSize: 3, // Process 3 days at a time to reduce memory pressure
  forceRecalculate: false,
  skipExisting: true,
  enableGc: false, // Disable garbage collection by default
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<BackfillConfig> {
  const args = process.argv.slice(2);
  const config: Partial<BackfillConfig> = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    
    switch (flag) {
      case '--start-date':
        config.startDate = value;
        break;
      case '--end-date':
        config.endDate = value;
        break;
      case '--concurrency':
        config.concurrency = parseInt(value);
        break;
      case '--batch-size':
        config.batchSize = parseInt(value);
        break;
      case '--force':
        config.forceRecalculate = true;
        config.skipExisting = false;
        break;
      case '--enable-gc':
        config.enableGc = true;
        break;
      case '--database-url':
        config.databaseUrl = value;
        break;
      default:
        console.warn(`Unknown flag: ${flag}`);
    }
  }
  
  return config;
}

/**
 * Initialize database connection
 */
async function createDataSource(databaseUrl: string): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [Transaction, Block, DailyStats],
    logging: false,
    synchronize: false,
    namingStrategy: new SnakeNamingStrategy()
  });
  
  await dataSource.initialize();
  logger.info('Database connection established');
  
  return dataSource;
}

/**
 * Generate date range array
 */
function generateDateRange(startDate: string, endDate: string): Date[] {
  const dates: Date[] = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  
  while (current <= end) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

/**
 * Check if daily stats already exist for a date
 */
async function checkExistingStats(
  dataSource: DataSource, 
  date: Date
): Promise<boolean> {
  const dailyStatsRepo = dataSource.getRepository(DailyStats);
  const dateStr = date.toISOString().split('T')[0];
  
  const existing = await dailyStatsRepo.findOne({
    where: { id: dateStr }
  });
  
  return !!existing;
}

/**
 * Process dates in batches with concurrency control
 */
async function processBatch(
  dates: Date[],
  processor: DailyStatsProcessor,
  config: BackfillConfig
): Promise<void> {
  const chunks: Date[][] = [];
  
  // Split dates into chunks
  for (let i = 0; i < dates.length; i += config.batchSize) {
    chunks.push(dates.slice(i, i + config.batchSize));
  }
  
  logger.info(`Processing ${dates.length} dates in ${chunks.length} batches`, {
    batchSize: config.batchSize,
    concurrency: config.concurrency
  });
  
  // Process chunks with limited concurrency
  for (let i = 0; i < chunks.length; i += config.concurrency) {
    const concurrentChunks = chunks.slice(i, i + config.concurrency);
    
    const promises = concurrentChunks.map(async (chunk) => {
      for (const date of chunk) {
        try {
          const dateStr = date.toISOString().split('T')[0];
          
          logger.info(`Processing daily stats for ${dateStr}`);
          
          const result = await processor.computeDailyStats(date, config.forceRecalculate);
          
          logger.info(`✅ Completed daily stats for ${dateStr}`, {
            transactionCount: result.transactionCount,
            blockCount: result.blockCount,
            uniqueAddresses: result.uniqueAddresses,
            totalGasUsed: result.totalGasUsed.toString(),
            averageGasPrice: result.averageGasPrice.toString()
          });
          
        } catch (error) {
          logger.error(`❌ Failed to process daily stats for ${date.toISOString().split('T')[0]}`, {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    });
    
    await Promise.all(promises);
    
    // Force garbage collection after each batch to free memory
    if (config.enableGc && global.gc) {
      global.gc();
    }
    
    logger.info(`Completed batch ${Math.floor(i / config.concurrency) + 1}/${Math.ceil(chunks.length / config.concurrency)}`);
  }
}

/**
 * Validate configuration
 */
function validateConfig(config: BackfillConfig): void {
  const startDate = new Date(config.startDate);
  const endDate = new Date(config.endDate);
  
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new Error('Invalid date format. Use YYYY-MM-DD format.');
  }
  
  if (startDate > endDate) {
    throw new Error('Start date must be before or equal to end date.');
  }
  
  if (config.concurrency < 1 || config.batchSize < 1) {
    throw new Error('Concurrency and batch size must be positive integers.');
  }
}

/**
 * Display help information
 */
function displayHelp(): void {
  console.log(`
Daily Stats Backfill Script

Usage:
  npm run backfill-daily-stats [options]

Options:
  --start-date YYYY-MM-DD    Start date for backfill (default: 2024-01-01)
  --end-date YYYY-MM-DD      End date for backfill (default: today)
  --concurrency N            Number of concurrent batches (default: 2)
  --batch-size N             Number of dates per batch (default: 3)
  --force                    Force recalculation of existing stats
  --enable-gc                Enable garbage collection for memory management
  --database-url URL         Database connection URL
  --help                     Display this help message

Examples:
  # Backfill last 30 days
  npm run backfill-daily-stats --start-date 2024-12-01 --end-date 2024-12-31

  # Force recalculate all stats
  npm run backfill-daily-stats --force

  # Use custom database URL
  npm run backfill-daily-stats --database-url postgresql://user:pass@host:5432/db
  `);
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  try {
    // Check for help flag
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      displayHelp();
      return;
    }
    
    // Parse configuration
    const userConfig = parseArgs();
    const config: BackfillConfig = { ...DEFAULT_CONFIG, ...userConfig };
    
    // Validate configuration
    validateConfig(config);
    
    logger.info('Starting daily stats backfill', {
      startDate: config.startDate,
      endDate: config.endDate,
      concurrency: config.concurrency,
      batchSize: config.batchSize,
      forceRecalculate: config.forceRecalculate,
      skipExisting: config.skipExisting,
      enableGc: config.enableGc
    });
    
    // Initialize database connection
    const dataSource = await createDataSource(config.databaseUrl);
    
    try {
      // Initialize daily stats processor
      const processor = new DailyStatsProcessor(dataSource, {
        skipExisting: config.skipExisting
      });
      
      // Generate date range
      const dates = generateDateRange(config.startDate, config.endDate);
      
      logger.info(`Generated ${dates.length} dates for processing`);
      
      // Filter out existing dates if skipExisting is true
      let datesToProcess = dates;
      
      if (config.skipExisting && !config.forceRecalculate) {
        const existingChecks = await Promise.all(
          dates.map(async (date) => ({
            date,
            exists: await checkExistingStats(dataSource, date)
          }))
        );
        
        datesToProcess = existingChecks
          .filter(check => !check.exists)
          .map(check => check.date);
        
        const skippedCount = dates.length - datesToProcess.length;
        if (skippedCount > 0) {
          logger.info(`Skipping ${skippedCount} dates with existing stats`);
        }
      }
      
      if (datesToProcess.length === 0) {
        logger.info('No dates to process - all stats already exist');
        return;
      }
      
      logger.info(`Processing ${datesToProcess.length} dates`);
      
      // Process the dates
      const startTime = Date.now();
      await processBatch(datesToProcess, processor, config);
      const duration = Date.now() - startTime;
      
      logger.info('✅ Daily stats backfill completed successfully', {
        processedDates: datesToProcess.length,
        totalDuration: `${Math.round(duration / 1000)}s`,
        averagePerDate: `${Math.round(duration / datesToProcess.length)}ms`
      });
      
    } finally {
      await dataSource.destroy();
      logger.info('Database connection closed');
    }
    
  } catch (error) {
    logger.error('❌ Daily stats backfill failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
  }
}

// Execute main function
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 