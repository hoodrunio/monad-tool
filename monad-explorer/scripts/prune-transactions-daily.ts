#!/usr/bin/env tsx

// Increase Node.js heap size for large pruning operations
if (process.env.NODE_OPTIONS && !process.env.NODE_OPTIONS.includes('--max-old-space-size')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS} --max-old-space-size=8192`;
} else if (!process.env.NODE_OPTIONS) {
  process.env.NODE_OPTIONS = '--max-old-space-size=8192';
}

import { Pool } from 'pg';
import { logger } from '../src/utils/logger';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration for daily parallel pruning operations
 */
interface DailyPruneConfig {
  // Date range options
  beforeDate?: string;
  afterDate?: string;
  fromDate?: string;
  toDate?: string;
  keepCount?: number;
  
  // Processing options
  batchSize: number;
  maxWorkers: number;
  dryRun: boolean;
  confirm: boolean;
  enableGc: boolean;
  
  // Database connection
  databaseUrl: string;
}

/**
 * Worker task for a specific day
 */
interface DayWorkerTask {
  workerId: number;
  date: string;
  offset: number;
  limit: number;
  batchSize: number;
  dryRun: boolean;
  enableGc: boolean;
}

/**
 * Worker result for a day
 */
interface DayWorkerResult {
  workerId: number;
  date: string;
  transactionsDeleted: number;
  logsDeleted: number;
  duration: number;
  chunksProcessed: number;
}

/**
 * Daily summary
 */
interface DaySummary {
  date: string;
  totalTransactions: number;
  totalLogs: number;
  duration: number;
  workersUsed: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: DailyPruneConfig = {
  batchSize: 10000,         // 10K per batch within worker
  maxWorkers: 5,           // Use all available threads
  dryRun: false,
  confirm: false,
  enableGc: true,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<DailyPruneConfig> {
  const args = process.argv.slice(2);
  const config: Partial<DailyPruneConfig> = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    
    switch (flag) {
      case '--before-date':
        config.beforeDate = value;
        break;
      case '--after-date':
        config.afterDate = value;
        break;
      case '--from-date':
        config.fromDate = value;
        break;
      case '--to-date':
        config.toDate = value;
        break;
      case '--keep-count':
        config.keepCount = parseInt(value);
        break;
      case '--batch-size':
        config.batchSize = parseInt(value);
        break;
      case '--max-workers':
        config.maxWorkers = parseInt(value);
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--confirm':
        config.confirm = true;
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
 * Create connection pool for parallel operations
 */
function createConnectionPool(databaseUrl: string, maxConnections: number): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: maxConnections + 2, // +2 for coordination queries
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

/**
 * Get list of days to process
 */
function getDaysToProcess(startDate: Date, endDate: Date): string[] {
  const days: string[] = [];
  const currentDate = new Date(startDate);
  
  while (currentDate <= endDate) {
    days.push(currentDate.toISOString().split('T')[0]); // YYYY-MM-DD format
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return days;
}

/**
 * Count transactions for a specific day
 */
async function countTransactionsForDay(pool: Pool, date: string): Promise<number> {
  const client = await pool.connect();
  try {
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;
    
    const result = await client.query(
      'SELECT COUNT(*) as count FROM transaction WHERE timestamp >= $1 AND timestamp <= $2',
      [startOfDay, endOfDay]
    );
    return parseInt(result.rows[0].count);
  } finally {
    client.release();
  }
}

/**
 * Delete transactions for a day chunk using raw SQL
 */
async function deleteDayChunk(
  pool: Pool,
  date: string,
  offset: number,
  limit: number,
  batchSize: number,
  dryRun: boolean,
  enableGc: boolean,
  workerId: number
): Promise<{ transactionsDeleted: number; logsDeleted: number; chunksProcessed: number }> {
  const client = await pool.connect();
  let totalTransactionsDeleted = 0;
  let totalLogsDeleted = 0;
  let chunksProcessed = 0;
  
  try {
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;
    
    let currentOffset = offset;
    let remaining = limit;
    
    while (remaining > 0) {
      const currentBatchSize = Math.min(batchSize, remaining);
      
      // Get batch of transaction IDs for this day
      const transactionResult = await client.query(`
        SELECT id FROM transaction 
        WHERE timestamp >= $1 AND timestamp <= $2 
        ORDER BY id 
        LIMIT $3 OFFSET $4
      `, [startOfDay, endOfDay, currentBatchSize, currentOffset]);
      
      if (transactionResult.rows.length === 0) {
        break;
      }
      
      const transactionIds = transactionResult.rows.map(row => row.id);
      
      if (dryRun) {
        // Count logs that would be deleted
        const logCountResult = await client.query(`
          SELECT COUNT(*) as count FROM log 
          WHERE transaction_id = ANY($1)
        `, [transactionIds]);
        
        const logCount = parseInt(logCountResult.rows[0].count);
        totalLogsDeleted += logCount;
        totalTransactionsDeleted += transactionIds.length;
        
        logger.info(`[Worker ${workerId}] [${date}] [DRY RUN] Would delete ${transactionIds.length} transactions and ${logCount} logs (chunk ${chunksProcessed + 1})`);
      } else {
        // Delete logs first
        const logDeleteResult = await client.query(`
          DELETE FROM log WHERE transaction_id = ANY($1)
        `, [transactionIds]);
        
        const logsDeleted = logDeleteResult.rowCount || 0;
        totalLogsDeleted += logsDeleted;
        
        // Delete transactions
        const transactionDeleteResult = await client.query(`
          DELETE FROM transaction WHERE id = ANY($1)
        `, [transactionIds]);
        
        const transactionsDeleted = transactionDeleteResult.rowCount || 0;
        totalTransactionsDeleted += transactionsDeleted;
        
        logger.info(`[Worker ${workerId}] [${date}] Deleted ${transactionsDeleted} transactions and ${logsDeleted} logs (chunk ${chunksProcessed + 1})`);
      }
      
      currentOffset += currentBatchSize;
      remaining -= transactionIds.length;
      chunksProcessed++;
      
      // Force garbage collection if enabled
      if (enableGc && global.gc) {
        global.gc();
      }
      
      // If we got fewer transactions than requested, we're done
      if (transactionIds.length < currentBatchSize) {
        break;
      }
    }
    
  } finally {
    client.release();
  }
  
  return { transactionsDeleted: totalTransactionsDeleted, logsDeleted: totalLogsDeleted, chunksProcessed };
}

/**
 * Worker function for processing a day chunk
 */
async function processDayWorker(task: DayWorkerTask): Promise<DayWorkerResult> {
  const startTime = Date.now();
  const pool = createConnectionPool(DEFAULT_CONFIG.databaseUrl, 1); // Single connection per worker
  
  try {
    logger.info(`[Worker ${task.workerId}] [${task.date}] Starting work on offset ${task.offset}, limit ${task.limit}`);
    
    const result = await deleteDayChunk(
      pool,
      task.date,
      task.offset,
      task.limit,
      task.batchSize,
      task.dryRun,
      task.enableGc,
      task.workerId
    );
    
    const duration = Date.now() - startTime;
    
    logger.info(`[Worker ${task.workerId}] [${task.date}] Completed: ${result.transactionsDeleted} transactions, ${result.logsDeleted} logs in ${Math.round(duration/1000)}s`);
    
    return {
      workerId: task.workerId,
      date: task.date,
      transactionsDeleted: result.transactionsDeleted,
      logsDeleted: result.logsDeleted,
      duration,
      chunksProcessed: result.chunksProcessed
    };
    
  } finally {
    await pool.end();
  }
}

/**
 * Process a single day with all workers
 */
async function processDay(
  date: string,
  transactionCount: number,
  config: DailyPruneConfig
): Promise<DaySummary> {
  if (transactionCount === 0) {
    logger.info(`[${date}] No transactions to process`);
    return {
      date,
      totalTransactions: 0,
      totalLogs: 0,
      duration: 0,
      workersUsed: 0
    };
  }
  
  const startTime = Date.now();
  
  // Split work among workers
  const transactionsPerWorker = Math.ceil(transactionCount / config.maxWorkers);
  const tasks: DayWorkerTask[] = [];
  
  for (let i = 0; i < config.maxWorkers; i++) {
    const offset = i * transactionsPerWorker;
    const limit = Math.min(transactionsPerWorker, transactionCount - offset);
    
    if (limit <= 0) break;
    
    tasks.push({
      workerId: i + 1,
      date,
      offset,
      limit,
      batchSize: config.batchSize,
      dryRun: config.dryRun,
      enableGc: config.enableGc
    });
  }
  
  logger.info(`[${date}] Starting ${tasks.length} workers for ${transactionCount} transactions...`);
  
  // Run all workers for this day in parallel
  const results = await Promise.all(tasks.map(task => processDayWorker(task)));
  
  // Aggregate results
  const totalTransactions = results.reduce((sum, r) => sum + r.transactionsDeleted, 0);
  const totalLogs = results.reduce((sum, r) => sum + r.logsDeleted, 0);
  const duration = Date.now() - startTime;
  
  logger.info(`[${date}] ✅ Day completed: ${totalTransactions} transactions, ${totalLogs} logs deleted by ${tasks.length} workers in ${Math.round(duration/1000)}s`);
  
  return {
    date,
    totalTransactions,
    totalLogs,
    duration,
    workersUsed: tasks.length
  };
}

/**
 * Validate configuration
 */
function validateConfig(config: DailyPruneConfig): void {
  const hasDateOption = config.beforeDate || config.afterDate || config.fromDate || config.toDate;
  const hasCountOption = config.keepCount !== undefined;
  
  if (!hasDateOption && !hasCountOption) {
    throw new Error('At least one option must be provided (date options or --keep-count)');
  }
  
  if (hasDateOption && hasCountOption) {
    throw new Error('Date options and --keep-count cannot be used together');
  }
  
  if (config.maxWorkers < 1 || config.maxWorkers > 20) {
    throw new Error('Max workers must be between 1 and 20');
  }
}

/**
 * Get date range for pruning
 */
function getDateRange(config: DailyPruneConfig): { startDate: Date; endDate: Date } {
  let startDate: Date;
  let endDate: Date;
  
  if (config.beforeDate) {
    endDate = new Date(config.beforeDate);
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setDate(endDate.getDate() - 1); // beforeDate is exclusive
    startDate = new Date('2020-01-01'); // Default start
  } else if (config.toDate) {
    endDate = new Date(config.toDate);
    endDate.setUTCHours(23, 59, 59, 999);
    startDate = new Date('2020-01-01'); // Default start
  } else if (config.fromDate && config.toDate) {
    startDate = new Date(config.fromDate);
    startDate.setUTCHours(0, 0, 0, 0);
    endDate = new Date(config.toDate);
    endDate.setUTCHours(23, 59, 59, 999);
  } else {
    throw new Error('Invalid date range configuration');
  }
  
  return { startDate, endDate };
}

/**
 * Get user confirmation
 */
async function getConfirmation(config: DailyPruneConfig): Promise<boolean> {
  if (config.confirm) {
    return true;
  }
  
  const { startDate, endDate } = getDateRange(config);
  const days = getDaysToProcess(startDate, endDate);
  
  console.log('\n=== DAILY PARALLEL PRUNING OPERATION SUMMARY ===');
  console.log(`Database URL: ${config.databaseUrl}`);
  console.log(`Batch Size: ${config.batchSize}`);
  console.log(`Max Workers: ${config.maxWorkers}`);
  console.log(`Dry Run: ${config.dryRun}`);
  console.log(`Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`Total Days: ${days.length}`);
  
  console.log('\n⚠️  WARNING: This will process days sequentially with parallel workers per day!');
  console.log('   Make sure your database can handle the concurrent load.');
  
  if (config.dryRun) {
    console.log('\n✅ This is a DRY RUN - no data will be deleted.');
    return true;
  }
  
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question('\nDo you want to proceed with daily parallel deletion? (yes/no): ', (answer: string) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  try {
    // Parse configuration
    const userConfig = parseArgs();
    const config: DailyPruneConfig = { ...DEFAULT_CONFIG, ...userConfig };
    
    // Validate configuration
    validateConfig(config);
    
    // Get user confirmation
    const confirmed = await getConfirmation(config);
    if (!confirmed) {
      logger.info('Operation cancelled by user');
      return;
    }
    
    const { startDate, endDate } = getDateRange(config);
    const days = getDaysToProcess(startDate, endDate);
    
    logger.info('Starting daily parallel transaction pruning operation', {
      dateRange: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
      totalDays: days.length,
      batchSize: config.batchSize,
      maxWorkers: config.maxWorkers,
      dryRun: config.dryRun,
      enableGc: config.enableGc
    });
    
    // Create connection pool for coordination
    const coordinatorPool = createConnectionPool(config.databaseUrl, 2);
    
    try {
      const overallStartTime = Date.now();
      const daySummaries: DaySummary[] = [];
      let totalTransactionsDeleted = 0;
      let totalLogsDeleted = 0;
      
      // Process each day sequentially
      for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
        const date = days[dayIndex];
        
        logger.info(`\n📅 Processing day ${dayIndex + 1}/${days.length}: ${date}`);
        
        // Count transactions for this day
        const transactionCount = await countTransactionsForDay(coordinatorPool, date);
        
        if (transactionCount === 0) {
          logger.info(`[${date}] No transactions found, skipping`);
          continue;
        }
        
        logger.info(`[${date}] Found ${transactionCount} transactions to process`);
        
        // Process this day with all workers
        const daySummary = await processDay(date, transactionCount, config);
        daySummaries.push(daySummary);
        
        totalTransactionsDeleted += daySummary.totalTransactions;
        totalLogsDeleted += daySummary.totalLogs;
        
        const remainingDays = days.length - dayIndex - 1;
        logger.info(`[${date}] Progress: ${dayIndex + 1}/${days.length} days completed (${remainingDays} remaining)`);
      }
      
      const overallDuration = Date.now() - overallStartTime;
      
      logger.info('\n✅ Daily parallel transaction pruning completed successfully', {
        totalDaysProcessed: daySummaries.length,
        totalTransactionsDeleted,
        totalLogsDeleted,
        totalDeleted: totalTransactionsDeleted + totalLogsDeleted,
        overallDuration: `${Math.round(overallDuration / 1000)}s`,
        averageTimePerDay: daySummaries.length > 0 ? `${Math.round(overallDuration / daySummaries.length / 1000)}s` : 'N/A'
      });
      
      // Show daily summary
      daySummaries.forEach(summary => {
        if (summary.totalTransactions > 0) {
          logger.info(`Daily summary - ${summary.date}:`, {
            transactions: summary.totalTransactions,
            logs: summary.totalLogs,
            duration: `${Math.round(summary.duration / 1000)}s`,
            workers: summary.workersUsed
          });
        }
      });
      
    } finally {
      await coordinatorPool.end();
    }
    
  } catch (error) {
    logger.error('❌ Daily parallel transaction pruning failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
  }
}

// Execute main function
if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
} 