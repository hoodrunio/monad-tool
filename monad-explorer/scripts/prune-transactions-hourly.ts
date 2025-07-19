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
 * Configuration for hourly parallel pruning operations
 */
interface HourlyPruneConfig {
  // Date range options
  beforeDate?: string;
  afterDate?: string;
  fromDate?: string;
  toDate?: string;
  keepCount?: number;
  
  // Processing options
  batchSize: number;
  maxWorkers: number;
  largeThreshold: number; // Transactions per day to trigger hourly processing
  dryRun: boolean;
  confirm: boolean;
  enableGc: boolean;
  
  // Database connection
  databaseUrl: string;
}

/**
 * Worker task for a specific hour
 */
interface HourWorkerTask {
  workerId: number;
  date: string;
  hour: number;
  offset: number;
  limit: number;
  batchSize: number;
  dryRun: boolean;
  enableGc: boolean;
}

/**
 * Hour processing result
 */
interface HourResult {
  date: string;
  hour: number;
  totalTransactions: number;
  totalLogs: number;
  duration: number;
  workersUsed: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: HourlyPruneConfig = {
  batchSize: 25000,         // Larger batches for hourly processing
  maxWorkers: 11,           // Use all available threads
  largeThreshold: 100000,   // Process hourly if day has >100K transactions
  dryRun: false,
  confirm: false,
  enableGc: true,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<HourlyPruneConfig> {
  const args = process.argv.slice(2);
  const config: Partial<HourlyPruneConfig> = {};
  
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
      case '--large-threshold':
        config.largeThreshold = parseInt(value);
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
 * Count transactions for a specific hour
 */
async function countTransactionsForHour(pool: Pool, date: string, hour: number): Promise<number> {
  const client = await pool.connect();
  try {
    const startOfHour = `${date}T${hour.toString().padStart(2, '0')}:00:00.000Z`;
    const endOfHour = `${date}T${hour.toString().padStart(2, '0')}:59:59.999Z`;
    
    const result = await client.query(
      'SELECT COUNT(*) as count FROM transaction WHERE timestamp >= $1 AND timestamp <= $2',
      [startOfHour, endOfHour]
    );
    return parseInt(result.rows[0].count);
  } finally {
    client.release();
  }
}

/**
 * Delete transactions for an hour chunk using raw SQL
 */
async function deleteHourChunk(
  pool: Pool,
  date: string,
  hour: number,
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
    let startTime: string;
    let endTime: string;
    
    if (hour === -1) {
      // Full day processing
      startTime = `${date}T00:00:00.000Z`;
      endTime = `${date}T23:59:59.999Z`;
    } else {
      // Specific hour processing
      startTime = `${date}T${hour.toString().padStart(2, '0')}:00:00.000Z`;
      endTime = `${date}T${hour.toString().padStart(2, '0')}:59:59.999Z`;
    }
    
    let currentOffset = offset;
    let remaining = limit;
    
    while (remaining > 0) {
      const currentBatchSize = Math.min(batchSize, remaining);
      
      // Get batch of transaction IDs for this time period
      const transactionResult = await client.query(`
        SELECT id FROM transaction 
        WHERE timestamp >= $1 AND timestamp <= $2 
        ORDER BY id 
        LIMIT $3 OFFSET $4
      `, [startTime, endTime, currentBatchSize, currentOffset]);
      
      if (transactionResult.rows.length === 0) {
        break;
      }
      
      const transactionIds = transactionResult.rows.map(row => row.id);
      
      if (dryRun) {
        // Count all related records that would be deleted
        const logCountResult = await client.query(`
          SELECT COUNT(*) as count FROM log 
          WHERE transaction_id = ANY($1)
        `, [transactionIds]);
        
        const contractCountResult = await client.query(`
          SELECT COUNT(*) as count FROM contract 
          WHERE creation_transaction_id = ANY($1)
        `, [transactionIds]);
        
        const internalTxCountResult = await client.query(`
          SELECT COUNT(*) as count FROM internal_transaction 
          WHERE transaction_id = ANY($1)
        `, [transactionIds]);
        
        const logCount = parseInt(logCountResult.rows[0].count);
        const contractCount = parseInt(contractCountResult.rows[0].count);
        const internalTxCount = parseInt(internalTxCountResult.rows[0].count);
        
        totalLogsDeleted += logCount + contractCount + internalTxCount;
        totalTransactionsDeleted += transactionIds.length;
        
        logger.info(`[Worker ${workerId}] [${date} ${hour}:00] [DRY RUN] Would delete ${transactionIds.length} transactions, ${logCount} logs, ${contractCount} contracts, ${internalTxCount} internal_txs (chunk ${chunksProcessed + 1})`);
      } else {
        // Delete in correct order: logs → contracts → internal_transactions → transactions
        
        // 1. Delete logs
        const logDeleteResult = await client.query(`
          DELETE FROM log WHERE transaction_id = ANY($1)
        `, [transactionIds]);
        
        // 2. Delete contracts
        const contractDeleteResult = await client.query(`
          DELETE FROM contract WHERE creation_transaction_id = ANY($1)
        `, [transactionIds]);
        
        // 3. Delete internal transactions  
        const internalTxDeleteResult = await client.query(`
          DELETE FROM internal_transaction WHERE transaction_id = ANY($1)
        `, [transactionIds]);
        
        // 4. Delete transactions
        const transactionDeleteResult = await client.query(`
          DELETE FROM transaction WHERE id = ANY($1)
        `, [transactionIds]);
        
        const logsDeleted = logDeleteResult.rowCount || 0;
        const contractsDeleted = contractDeleteResult.rowCount || 0;
        const internalTxsDeleted = internalTxDeleteResult.rowCount || 0;
        const transactionsDeleted = transactionDeleteResult.rowCount || 0;
        
        totalLogsDeleted += logsDeleted + contractsDeleted + internalTxsDeleted;
        totalTransactionsDeleted += transactionsDeleted;
        
        logger.info(`[Worker ${workerId}] [${date} ${hour}:00] Deleted ${transactionsDeleted} transactions, ${logsDeleted} logs, ${contractsDeleted} contracts, ${internalTxsDeleted} internal_txs (chunk ${chunksProcessed + 1})`);
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
 * Worker function for processing an hour chunk
 */
async function processHourWorker(task: HourWorkerTask): Promise<any> {
  const startTime = Date.now();
  const pool = createConnectionPool(DEFAULT_CONFIG.databaseUrl, 1); // Single connection per worker
  
  try {
    const timeLabel = task.hour === -1 ? 'FULL-DAY' : `${task.hour}:00`;
    logger.info(`[Worker ${task.workerId}] [${task.date} ${timeLabel}] Starting work on offset ${task.offset}, limit ${task.limit}`);
    
    const result = await deleteHourChunk(
      pool,
      task.date,
      task.hour,
      task.offset,
      task.limit,
      task.batchSize,
      task.dryRun,
      task.enableGc,
      task.workerId
    );
    
    const duration = Date.now() - startTime;
    
    logger.info(`[Worker ${task.workerId}] [${task.date} ${timeLabel}] Completed: ${result.transactionsDeleted} transactions, ${result.logsDeleted} logs in ${Math.round(duration/1000)}s`);
    
    return {
      workerId: task.workerId,
      date: task.date,
      hour: task.hour,
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
 * Process a single hour with all workers
 */
async function processHour(
  date: string,
  hour: number,
  transactionCount: number,
  config: HourlyPruneConfig
): Promise<HourResult> {
  if (transactionCount === 0) {
    return {
      date,
      hour,
      totalTransactions: 0,
      totalLogs: 0,
      duration: 0,
      workersUsed: 0
    };
  }
  
  const startTime = Date.now();
  
  // Split work among workers
  const transactionsPerWorker = Math.ceil(transactionCount / config.maxWorkers);
  const tasks: HourWorkerTask[] = [];
  
  for (let i = 0; i < config.maxWorkers; i++) {
    const offset = i * transactionsPerWorker;
    const limit = Math.min(transactionsPerWorker, transactionCount - offset);
    
    if (limit <= 0) break;
    
    tasks.push({
      workerId: i + 1,
      date,
      hour,
      offset,
      limit,
      batchSize: config.batchSize,
      dryRun: config.dryRun,
      enableGc: config.enableGc
    });
  }
  
  logger.info(`[${date} ${hour}:00] Starting ${tasks.length} workers for ${transactionCount} transactions...`);
  
  // Run all workers for this hour in parallel
  const results = await Promise.all(tasks.map(task => processHourWorker(task)));
  
  // Aggregate results
  const totalTransactions = results.reduce((sum, r) => sum + r.transactionsDeleted, 0);
  const totalLogs = results.reduce((sum, r) => sum + r.logsDeleted, 0);
  const duration = Date.now() - startTime;
  
  logger.info(`[${date} ${hour}:00] ✅ Hour completed: ${totalTransactions} transactions, ${totalLogs} logs deleted by ${tasks.length} workers in ${Math.round(duration/1000)}s`);
  
  return {
    date,
    hour,
    totalTransactions,
    totalLogs,
    duration,
    workersUsed: tasks.length
  };
}

/**
 * Process a large day hour by hour
 */
async function processLargeDay(
  date: string,
  transactionCount: number,
  config: HourlyPruneConfig,
  coordinatorPool: Pool
): Promise<{ totalTransactions: number; totalLogs: number; duration: number }> {
  const startTime = Date.now();
  let totalTransactions = 0;
  let totalLogs = 0;
  
  logger.info(`🔥 [${date}] LARGE DAY DETECTED: ${transactionCount} transactions - Processing hour by hour...`);
  
  // Process each hour sequentially 
  for (let hour = 0; hour < 24; hour++) {
    const hourTransactionCount = await countTransactionsForHour(coordinatorPool, date, hour);
    
    if (hourTransactionCount === 0) {
      continue; // Skip empty hours
    }
    
    logger.info(`⏰ [${date} ${hour}:00] Found ${hourTransactionCount} transactions`);
    
    const hourResult = await processHour(date, hour, hourTransactionCount, config);
    totalTransactions += hourResult.totalTransactions;
    totalLogs += hourResult.totalLogs;
    
    logger.info(`⏰ [${date} ${hour}:00] Progress: Hour ${hour + 1}/24 completed`);
  }
  
  const duration = Date.now() - startTime;
  return { totalTransactions, totalLogs, duration };
}

/**
 * Process a regular day normally (from the daily script)
 */
async function processRegularDay(
  date: string,
  transactionCount: number,
  config: HourlyPruneConfig
): Promise<{ totalTransactions: number; totalLogs: number; duration: number }> {
  const startTime = Date.now();
  
  // Use the same logic as daily processing (hour -1 indicates full day processing)
  const transactionsPerWorker = Math.ceil(transactionCount / config.maxWorkers);
  const tasks: any[] = [];
  
  for (let i = 0; i < config.maxWorkers; i++) {
    const offset = i * transactionsPerWorker;
    const limit = Math.min(transactionsPerWorker, transactionCount - offset);
    
    if (limit <= 0) break;
    
    tasks.push({
      workerId: i + 1,
      date,
      hour: -1, // Flag for daily processing (full day, not hourly)
      offset,
      limit,
      batchSize: config.batchSize,
      dryRun: config.dryRun,
      enableGc: config.enableGc
    });
  }
  
  logger.info(`📅 [${date}] Starting ${tasks.length} workers for ${transactionCount} transactions...`);
  
  // Run all workers in parallel
  const results = await Promise.all(tasks.map(task => processHourWorker(task)));
  
  const totalTransactions = results.reduce((sum, r) => sum + r.transactionsDeleted, 0);
  const totalLogs = results.reduce((sum, r) => sum + r.logsDeleted, 0);
  const duration = Date.now() - startTime;
  
  logger.info(`📅 [${date}] ✅ Day completed: ${totalTransactions} transactions, ${totalLogs} logs deleted by ${tasks.length} workers in ${Math.round(duration/1000)}s`);
  
  return { totalTransactions, totalLogs, duration };
}

/**
 * Get date range for pruning
 */
function getDateRange(config: HourlyPruneConfig): { startDate: Date; endDate: Date } {
  let startDate: Date;
  let endDate: Date;
  
  if (config.beforeDate) {
    endDate = new Date(config.beforeDate);
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setDate(endDate.getDate() - 1); // beforeDate is exclusive
    startDate = new Date('2025-06-30'); // Default start
  } else if (config.toDate) {
    endDate = new Date(config.toDate);
    endDate.setUTCHours(23, 59, 59, 999);
    startDate = new Date('2025-06-30'); // Default start
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
 * Validate configuration
 */
function validateConfig(config: HourlyPruneConfig): void {
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
 * Get user confirmation
 */
async function getConfirmation(config: HourlyPruneConfig): Promise<boolean> {
  if (config.confirm) {
    return true;
  }
  
  const { startDate, endDate } = getDateRange(config);
  const days = getDaysToProcess(startDate, endDate);
  
  console.log('\n=== HOURLY PARALLEL PRUNING OPERATION SUMMARY ===');
  console.log(`Database URL: ${config.databaseUrl}`);
  console.log(`Batch Size: ${config.batchSize}`);
  console.log(`Max Workers: ${config.maxWorkers}`);
  console.log(`Large Day Threshold: ${config.largeThreshold} transactions`);
  console.log(`Dry Run: ${config.dryRun}`);
  console.log(`Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`Total Days: ${days.length}`);
  
  console.log('\n🚀 STRATEGY:');
  console.log(`   • Small days (<${config.largeThreshold} transactions): Normal daily processing`);
  console.log(`   • Large days (≥${config.largeThreshold} transactions): Hour-by-hour processing`);
  console.log(`   • Max parallel operations: ${config.maxWorkers} × 24 = ${config.maxWorkers * 24} for large days`);
  
  console.log('\n⚠️  WARNING: This will use adaptive processing strategy!');
  
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
    rl.question('\nDo you want to proceed with hourly adaptive deletion? (yes/no): ', (answer: string) => {
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
    const config: HourlyPruneConfig = { ...DEFAULT_CONFIG, ...userConfig };
    
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
    
    logger.info('Starting hourly adaptive transaction pruning operation', {
      dateRange: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
      totalDays: days.length,
      batchSize: config.batchSize,
      maxWorkers: config.maxWorkers,
      largeThreshold: config.largeThreshold,
      dryRun: config.dryRun,
      enableGc: config.enableGc
    });
    
    // Create connection pool for coordination
    const coordinatorPool = createConnectionPool(config.databaseUrl, 2);
    
    try {
      const overallStartTime = Date.now();
      let totalTransactionsDeleted = 0;
      let totalLogsDeleted = 0;
      let largeDaysProcessed = 0;
      let regularDaysProcessed = 0;
      
      // Process each day
      for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
        const date = days[dayIndex];
        
        logger.info(`\n📅 Processing day ${dayIndex + 1}/${days.length}: ${date}`);
        
        // Count transactions for this day
        const transactionCount = await countTransactionsForDay(coordinatorPool, date);
        
        if (transactionCount === 0) {
          logger.info(`[${date}] No transactions found, skipping`);
          continue;
        }
        
        logger.info(`[${date}] Found ${transactionCount} transactions`);
        
        let dayResult;
        
        // Decide processing strategy
        if (transactionCount >= config.largeThreshold) {
          // Large day: Process hour by hour
          dayResult = await processLargeDay(date, transactionCount, config, coordinatorPool);
          largeDaysProcessed++;
        } else {
          // Regular day: Process normally
          dayResult = await processRegularDay(date, transactionCount, config);
          regularDaysProcessed++;
        }
        
        totalTransactionsDeleted += dayResult.totalTransactions;
        totalLogsDeleted += dayResult.totalLogs;
        
        const remainingDays = days.length - dayIndex - 1;
        logger.info(`[${date}] Progress: ${dayIndex + 1}/${days.length} days completed (${remainingDays} remaining)`);
      }
      
      const overallDuration = Date.now() - overallStartTime;
      
      logger.info('\n✅ Hourly adaptive transaction pruning completed successfully', {
        totalDaysProcessed: days.length,
        largeDaysProcessed,
        regularDaysProcessed,
        totalTransactionsDeleted,
        totalLogsDeleted,
        totalDeleted: totalTransactionsDeleted + totalLogsDeleted,
        overallDuration: `${Math.round(overallDuration / 1000)}s`,
        averageTimePerDay: days.length > 0 ? `${Math.round(overallDuration / days.length / 1000)}s` : 'N/A'
      });
      
    } finally {
      await coordinatorPool.end();
    }
    
  } catch (error) {
    logger.error('❌ Hourly adaptive transaction pruning failed', {
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