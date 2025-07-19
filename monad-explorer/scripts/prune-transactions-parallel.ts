#!/usr/bin/env tsx

// Increase Node.js heap size for large pruning operations
if (process.env.NODE_OPTIONS && !process.env.NODE_OPTIONS.includes('--max-old-space-size')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS} --max-old-space-size=8192`;
} else if (!process.env.NODE_OPTIONS) {
  process.env.NODE_OPTIONS = '--max-old-space-size=8192';
}

import { Pool, PoolClient } from 'pg';
import { logger } from '../src/utils/logger';
import dotenv from 'dotenv';
import cluster from 'cluster';
import os from 'os';

dotenv.config();

/**
 * Configuration for parallel pruning operations
 */
interface ParallelPruneConfig {
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
 * Worker task definition
 */
interface WorkerTask {
  workerId: number;
  startId: string;
  endId: string;
  estimatedCount: number;
  batchSize: number;
  dryRun: boolean;
  enableGc: boolean;
}

/**
 * Worker result
 */
interface WorkerResult {
  workerId: number;
  transactionsDeleted: number;
  logsDeleted: number;
  duration: number;
  dateRange: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ParallelPruneConfig = {
  batchSize: 50000,         // Larger batches for raw SQL
  maxWorkers: 8,           // Use all available threads
  dryRun: false,
  confirm: false,
  enableGc: true,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<ParallelPruneConfig> {
  const args = process.argv.slice(2);
  const config: Partial<ParallelPruneConfig> = {};
  
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
 * Split transactions into chunks by ID for parallel processing
 */
async function splitTransactionsByCount(
  pool: Pool,
  startDate: Date,
  endDate: Date,
  numChunks: number
): Promise<Array<{startId: string, endId: string, estimatedCount: number}>> {
  const client = await pool.connect();
  try {
    // Get total count and ID range
    const totalResult = await client.query(
      'SELECT COUNT(*) as count, MIN(id) as min_id, MAX(id) as max_id FROM transaction WHERE timestamp >= $1 AND timestamp <= $2',
      [startDate, endDate]
    );
    
    const totalCount = parseInt(totalResult.rows[0].count);
    const minId = totalResult.rows[0].min_id;
    const maxId = totalResult.rows[0].max_id;
    
    if (totalCount === 0) {
      return [];
    }
    
    const chunksPerWorker = Math.ceil(totalCount / numChunks);
    const chunks: Array<{startId: string, endId: string, estimatedCount: number}> = [];
    
    // Get transaction IDs at chunk boundaries
    for (let i = 0; i < numChunks; i++) {
      const offset = i * chunksPerWorker;
      const limit = Math.min(chunksPerWorker, totalCount - offset);
      
      if (limit <= 0) break;
      
      // Get start ID for this chunk
      const startResult = await client.query(`
        SELECT id FROM transaction 
        WHERE timestamp >= $1 AND timestamp <= $2 
        ORDER BY id 
        LIMIT 1 OFFSET $3
      `, [startDate, endDate, offset]);
      
      // Get end ID for this chunk
      const endOffset = offset + limit - 1;
      const endResult = await client.query(`
        SELECT id FROM transaction 
        WHERE timestamp >= $1 AND timestamp <= $2 
        ORDER BY id 
        LIMIT 1 OFFSET $3
      `, [startDate, endDate, endOffset]);
      
      if (startResult.rows.length > 0) {
        const startId = startResult.rows[0].id;
        const endId = endResult.rows.length > 0 ? endResult.rows[0].id : maxId;
        
        chunks.push({
          startId,
          endId,
          estimatedCount: limit
        });
      }
    }
    
    return chunks;
  } finally {
    client.release();
  }
}

/**
 * Count total transactions in date range using raw SQL
 */
async function countTransactionsInRange(
  pool: Pool,
  startDate: Date,
  endDate: Date
): Promise<number> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT COUNT(*) as count FROM transaction WHERE timestamp >= $1 AND timestamp <= $2',
      [startDate, endDate]
    );
    return parseInt(result.rows[0].count);
  } finally {
    client.release();
  }
}

/**
 * Delete logs and transactions in an ID range using raw SQL
 */
async function deleteInIdRange(
  pool: Pool,
  startId: string,
  endId: string,
  batchSize: number,
  dryRun: boolean,
  enableGc: boolean,
  workerId: number
): Promise<{ transactionsDeleted: number; logsDeleted: number }> {
  const client = await pool.connect();
  let totalTransactionsDeleted = 0;
  let totalLogsDeleted = 0;
  
  try {
    let currentId = startId;
    
    while (currentId <= endId) {
      // Get batch of transaction IDs in range
      const transactionResult = await client.query(`
        SELECT id FROM transaction 
        WHERE id >= $1 AND id <= $2 
        ORDER BY id 
        LIMIT $3
      `, [currentId, endId, batchSize]);
      
      if (transactionResult.rows.length === 0) {
        break;
      }
      
      const transactionIds = transactionResult.rows.map(row => row.id);
      const lastId = transactionIds[transactionIds.length - 1];
      
      if (dryRun) {
        // Count logs that would be deleted
        const logCountResult = await client.query(`
          SELECT COUNT(*) as count FROM log 
          WHERE transaction_id = ANY($1)
        `, [transactionIds]);
        
        const logCount = parseInt(logCountResult.rows[0].count);
        totalLogsDeleted += logCount;
        totalTransactionsDeleted += transactionIds.length;
        
        logger.info(`[Worker ${workerId}] [DRY RUN] Would delete ${transactionIds.length} transactions and ${logCount} logs`);
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
        
        logger.info(`[Worker ${workerId}] Deleted ${transactionsDeleted} transactions and ${logsDeleted} logs (batch)`);
      }
      
      // Move to next batch
      currentId = (parseInt(lastId) + 1).toString();
      
      // Force garbage collection if enabled
      if (enableGc && global.gc) {
        global.gc();
      }
    }
    
  } finally {
    client.release();
  }
  
  return { transactionsDeleted: totalTransactionsDeleted, logsDeleted: totalLogsDeleted };
}

/**
 * Worker process function
 */
async function runWorker(task: WorkerTask): Promise<WorkerResult> {
  const startTime = Date.now();
  const pool = createConnectionPool(DEFAULT_CONFIG.databaseUrl, 1); // Single connection per worker
  
  try {
    logger.info(`[Worker ${task.workerId}] Starting work on ID range: ${task.startId} to ${task.endId} (estimated: ${task.estimatedCount} transactions)`);
    
    const result = await deleteInIdRange(
      pool,
      task.startId,
      task.endId,
      task.batchSize,
      task.dryRun,
      task.enableGc,
      task.workerId
    );
    
    const duration = Date.now() - startTime;
    
    logger.info(`[Worker ${task.workerId}] Completed: ${result.transactionsDeleted} transactions, ${result.logsDeleted} logs in ${Math.round(duration/1000)}s`);
    
    return {
      workerId: task.workerId,
      transactionsDeleted: result.transactionsDeleted,
      logsDeleted: result.logsDeleted,
      duration,
      dateRange: `ID ${task.startId} to ${task.endId}`
    };
    
  } finally {
    await pool.end();
  }
}

/**
 * Validate configuration
 */
function validateConfig(config: ParallelPruneConfig): void {
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
function getDateRange(config: ParallelPruneConfig): { startDate: Date; endDate: Date } {
  let startDate: Date;
  let endDate: Date;
  
  if (config.beforeDate) {
    endDate = new Date(config.beforeDate);
    endDate.setUTCHours(0, 0, 0, 0);
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
async function getConfirmation(config: ParallelPruneConfig): Promise<boolean> {
  if (config.confirm) {
    return true;
  }
  
  const { startDate, endDate } = getDateRange(config);
  
  console.log('\n=== PARALLEL PRUNING OPERATION SUMMARY ===');
  console.log(`Database URL: ${config.databaseUrl}`);
  console.log(`Batch Size: ${config.batchSize}`);
  console.log(`Max Workers: ${config.maxWorkers}`);
  console.log(`Dry Run: ${config.dryRun}`);
  console.log(`Date Range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
  
  console.log('\n⚠️  WARNING: This will run parallel deletion operations!');
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
    rl.question('\nDo you want to proceed with parallel deletion? (yes/no): ', (answer: string) => {
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
    const config: ParallelPruneConfig = { ...DEFAULT_CONFIG, ...userConfig };
    
    // Validate configuration
    validateConfig(config);
    
    // Get user confirmation
    const confirmed = await getConfirmation(config);
    if (!confirmed) {
      logger.info('Operation cancelled by user');
      return;
    }
    
    const { startDate, endDate } = getDateRange(config);
    
    logger.info('Starting parallel transaction pruning operation', {
      dateRange: `${startDate.toISOString()} to ${endDate.toISOString()}`,
      batchSize: config.batchSize,
      maxWorkers: config.maxWorkers,
      dryRun: config.dryRun,
      enableGc: config.enableGc
    });
    
    // Create connection pool for coordination
    const coordinatorPool = createConnectionPool(config.databaseUrl, 2);
    
    try {
      // Count total transactions
      const totalTransactions = await countTransactionsInRange(coordinatorPool, startDate, endDate);
      logger.info(`Found ${totalTransactions} transactions to process`);
      
      if (totalTransactions === 0) {
        logger.info('No transactions found to delete');
        return;
      }
      
             // Split work into chunks by transaction ID
       const idChunks = await splitTransactionsByCount(coordinatorPool, startDate, endDate, config.maxWorkers);
       
       if (idChunks.length === 0) {
         logger.info('No transaction chunks found to process');
         return;
       }
       
       // Create worker tasks
       const tasks: WorkerTask[] = idChunks.map((chunk, index) => ({
         workerId: index + 1,
         startId: chunk.startId,
         endId: chunk.endId,
         estimatedCount: chunk.estimatedCount,
         batchSize: config.batchSize,
         dryRun: config.dryRun,
         enableGc: config.enableGc
       }));
      
      logger.info(`Starting ${config.maxWorkers} parallel workers...`);
      
      const startTime = Date.now();
      
      // Run all workers in parallel
      const results = await Promise.all(tasks.map(task => runWorker(task)));
      
      // Aggregate results
      const totalTransactionsDeleted = results.reduce((sum, r) => sum + r.transactionsDeleted, 0);
      const totalLogsDeleted = results.reduce((sum, r) => sum + r.logsDeleted, 0);
      const totalDuration = Date.now() - startTime;
      
      logger.info('✅ Parallel transaction pruning completed successfully', {
        totalTransactionsDeleted,
        totalLogsDeleted,
        totalDeleted: totalTransactionsDeleted + totalLogsDeleted,
        totalDuration: `${Math.round(totalDuration / 1000)}s`,
        workersUsed: config.maxWorkers,
        averagePerWorker: `${Math.round(totalTransactionsDeleted / config.maxWorkers)} transactions/worker`
      });
      
      // Show per-worker results
      results.forEach(result => {
        logger.info(`Worker ${result.workerId} results:`, {
          transactions: result.transactionsDeleted,
          logs: result.logsDeleted,
          duration: `${Math.round(result.duration / 1000)}s`,
          dateRange: result.dateRange
        });
      });
      
    } finally {
      await coordinatorPool.end();
    }
    
  } catch (error) {
    logger.error('❌ Parallel transaction pruning failed', {
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