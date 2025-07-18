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
  
  // Memory management
  memoryThresholdMB: number; // Memory threshold for dynamic batch size adjustment
  minBatchSize: number; // Minimum batch size
  maxBatchSize: number; // Maximum batch size
  gcFrequency: number; // Force GC every N processed items
  
  // Database connection
  databaseUrl: string;
}

/**
 * Default configuration - Optimized for memory efficiency
 */
const DEFAULT_CONFIG: BackfillConfig = {
  startDate: '2024-01-01',
  endDate: new Date().toISOString().split('T')[0], // Today
  concurrency: 1, // Reduced to 1 for maximum memory efficiency
  batchSize: 1, // Process 1 day at a time to minimize memory pressure
  forceRecalculate: false,
  skipExisting: true,
  enableGc: true, // Enable garbage collection by default
  
  // Memory management settings
  memoryThresholdMB: 2048, // 2GB threshold for memory monitoring
  minBatchSize: 1, // Minimum 1 day
  maxBatchSize: 2, // Maximum 2 days in memory
  gcFrequency: 1, // Force GC after every processed item
  
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Get current memory usage in MB
 */
function getMemoryUsageMB(): number {
  const memUsage = process.memoryUsage();
  return Math.round(memUsage.heapUsed / 1024 / 1024);
}

/**
 * Force garbage collection and log memory stats
 */
function forceGarbageCollection(): void {
  if (global.gc) {
    const beforeMB = getMemoryUsageMB();
    global.gc();
    const afterMB = getMemoryUsageMB();
    logger.debug('Forced garbage collection', {
      memoryBeforeMB: beforeMB,
      memoryAfterMB: afterMB,
      freedMB: beforeMB - afterMB
    });
  }
}

/**
 * Monitor memory usage and adjust batch size dynamically
 */
function adjustBatchSizeBasedOnMemory(
  currentBatchSize: number, 
  config: BackfillConfig
): number {
  const memoryUsageMB = getMemoryUsageMB();
  
  if (memoryUsageMB > config.memoryThresholdMB) {
    // Memory usage is high, reduce batch size
    const newBatchSize = Math.max(config.minBatchSize, Math.floor(currentBatchSize * 0.5));
    logger.warn('High memory usage detected, reducing batch size', {
      memoryUsageMB,
      threshold: config.memoryThresholdMB,
      oldBatchSize: currentBatchSize,
      newBatchSize
    });
    return newBatchSize;
  } else if (memoryUsageMB < config.memoryThresholdMB * 0.5 && currentBatchSize < config.maxBatchSize) {
    // Memory usage is low, we can increase batch size slightly
    const newBatchSize = Math.min(config.maxBatchSize, currentBatchSize + 1);
    logger.info('Low memory usage, increasing batch size', {
      memoryUsageMB,
      threshold: config.memoryThresholdMB,
      oldBatchSize: currentBatchSize,
      newBatchSize
    });
    return newBatchSize;
  }
  
  return currentBatchSize;
}

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
      case '--memory-threshold':
        config.memoryThresholdMB = parseInt(value);
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
 * Initialize database connection with optimized settings
 */
async function createDataSource(databaseUrl: string): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [Transaction, Block, DailyStats],
    logging: false,
    synchronize: false,
    namingStrategy: new SnakeNamingStrategy(),
    // Optimize connection pool for memory efficiency
    poolErrorHandler: (err) => logger.error('Database pool error', { error: err.message }),
    extra: {
      // Reduce connection pool size to save memory
      max: 3,
      min: 1,
      idle_timeout: 30000,
      // Optimize query performance
      statement_timeout: 300000, // 5 minutes
    }
  });
  
  await dataSource.initialize();
  logger.info('Database connection established with optimized settings');
  
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
 * Process dates in batches with memory-aware concurrency control
 */
async function processBatch(
  dates: Date[],
  processor: DailyStatsProcessor,
  config: BackfillConfig
): Promise<void> {
  let currentBatchSize = config.batchSize;
  let processedCount = 0;
  
  logger.info(`Processing ${dates.length} dates with memory-aware batching`, {
    initialBatchSize: currentBatchSize,
    concurrency: config.concurrency,
    memoryThresholdMB: config.memoryThresholdMB
  });
  
  for (let i = 0; i < dates.length; i += currentBatchSize) {
    // Adjust batch size based on current memory usage
    currentBatchSize = adjustBatchSizeBasedOnMemory(currentBatchSize, config);
    
    const batch = dates.slice(i, i + currentBatchSize);
    const batchNumber = Math.floor(i / currentBatchSize) + 1;
    const totalBatches = Math.ceil(dates.length / currentBatchSize);
    
    logger.info(`Processing batch ${batchNumber}/${totalBatches}`, {
      batchSize: batch.length,
      memoryUsageMB: getMemoryUsageMB(),
      dates: batch.map(d => d.toISOString().split('T')[0])
    });
    
    // Process dates in the current batch sequentially to control memory usage
    for (const date of batch) {
      try {
        const dateStr = date.toISOString().split('T')[0];
        
        logger.info(`Processing daily stats for ${dateStr}`, {
          memoryUsageMB: getMemoryUsageMB()
        });
        
        const result = await processor.computeDailyStats(date, config.forceRecalculate);
        
        logger.info(`✅ Completed daily stats for ${dateStr}`, {
          transactionCount: result.transactionCount,
          blockCount: result.blockCount,
          uniqueAddresses: result.uniqueAddresses,
          totalGasUsed: result.totalGasUsed.toString(),
          averageGasPrice: result.averageGasPrice.toString(),
          memoryUsageMB: getMemoryUsageMB()
        });
        
        processedCount++;
        
        // Force garbage collection after each date if enabled
        if (config.enableGc && processedCount % config.gcFrequency === 0) {
          forceGarbageCollection();
        }
        
      } catch (error) {
        logger.error(`❌ Failed to process daily stats for ${date.toISOString().split('T')[0]}`, {
          error: error instanceof Error ? error.message : 'Unknown error',
          memoryUsageMB: getMemoryUsageMB()
        });
        
        // Force garbage collection after errors to clean up partial data
        if (config.enableGc) {
          forceGarbageCollection();
        }
      }
    }
    
    // Force garbage collection after each batch
    if (config.enableGc) {
      forceGarbageCollection();
    }
    
    logger.info(`Completed batch ${batchNumber}/${totalBatches}`, {
      processedInBatch: batch.length,
      totalProcessed: processedCount,
      memoryUsageMB: getMemoryUsageMB()
    });
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
  
  if (config.minBatchSize < 1 || config.maxBatchSize < config.minBatchSize) {
    throw new Error('Invalid batch size configuration.');
  }
  
  if (config.memoryThresholdMB < 512) {
    throw new Error('Memory threshold must be at least 512MB.');
  }
}

/**
 * Display help information
 */
function displayHelp(): void {
  console.log(`
Daily Stats Backfill Script (Memory Optimized)

Usage:
  npm run backfill-daily-stats [options]

Options:
  --start-date YYYY-MM-DD      Start date for backfill (default: 2024-01-01)
  --end-date YYYY-MM-DD        End date for backfill (default: today)
  --concurrency N              Number of concurrent batches (default: 1, max recommended: 2)
  --batch-size N               Number of dates per batch (default: 1)
  --force                      Force recalculation of existing stats
  --enable-gc                  Enable aggressive garbage collection (default: true)
  --memory-threshold N         Memory threshold in MB for batch size adjustment (default: 2048)
  --database-url URL           Database connection URL
  --help                       Display this help message

Memory Optimization Features:
  - Dynamic batch size adjustment based on memory usage
  - Aggressive garbage collection between processing
  - Memory monitoring and logging
  - Optimized database connection pool
  - Sequential processing to control memory growth

Examples:
  # Memory-efficient backfill for last 30 days
  npm run backfill-daily-stats --start-date 2024-12-01 --end-date 2024-12-31

  # Force recalculate with custom memory threshold
  npm run backfill-daily-stats --force --memory-threshold 1024

  # Large dataset processing with minimal memory footprint
  npm run backfill-daily-stats --batch-size 1 --concurrency 1 --enable-gc
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
    
    logger.info('Starting memory-optimized daily stats backfill', {
      startDate: config.startDate,
      endDate: config.endDate,
      concurrency: config.concurrency,
      batchSize: config.batchSize,
      forceRecalculate: config.forceRecalculate,
      skipExisting: config.skipExisting,
      enableGc: config.enableGc,
      memoryThresholdMB: config.memoryThresholdMB,
      initialMemoryUsageMB: getMemoryUsageMB()
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
      
      logger.info(`Processing ${datesToProcess.length} dates with memory optimization`);
      
      // Process the dates
      const startTime = Date.now();
      await processBatch(datesToProcess, processor, config);
      const duration = Date.now() - startTime;
      
      // Final garbage collection
      if (config.enableGc) {
        forceGarbageCollection();
      }
      
      logger.info('✅ Memory-optimized daily stats backfill completed successfully', {
        processedDates: datesToProcess.length,
        totalDuration: `${Math.round(duration / 1000)}s`,
        averagePerDate: `${Math.round(duration / datesToProcess.length)}ms`,
        finalMemoryUsageMB: getMemoryUsageMB()
      });
      
    } finally {
      await dataSource.destroy();
      logger.info('Database connection closed');
    }
    
  } catch (error) {
    logger.error('❌ Memory-optimized daily stats backfill failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      memoryUsageMB: getMemoryUsageMB()
    });
    process.exit(1);
  }
}

// Execute main function
main().catch((error) => {
  console.error('Unhandled error:', error);
  console.error('Memory usage:', getMemoryUsageMB(), 'MB');
  process.exit(1);
}); 