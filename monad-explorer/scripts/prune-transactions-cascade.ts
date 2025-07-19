#!/usr/bin/env tsx

import { Pool } from 'pg';
import { logger } from '../src/utils/logger';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration for cascade pruning operations
 */
interface CascadePruneConfig {
  // Date range options
  beforeDate?: string;
  afterDate?: string;
  fromDate?: string;
  toDate?: string;
  
  // Processing options
  batchSize: number;
  dryRun: boolean;
  confirm: boolean;
  
  // Database connection
  databaseUrl: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: CascadePruneConfig = {
  batchSize: 100000, // Large batches for cascade deletes
  dryRun: false,
  confirm: false,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<CascadePruneConfig> {
  const args = process.argv.slice(2);
  const config: Partial<CascadePruneConfig> = {};
  
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
      case '--batch-size':
        config.batchSize = parseInt(value);
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--confirm':
        config.confirm = true;
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
 * Create connection pool
 */
function createConnectionPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 1, // Single connection for bulk operations
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

/**
 * Get date range for pruning
 */
function getDateRange(config: CascadePruneConfig): { startDate: Date | null; endDate: Date | null } {
  let startDate: Date | null = null;
  let endDate: Date | null = null;
  
  if (config.beforeDate) {
    endDate = new Date(config.beforeDate);
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setDate(endDate.getDate() - 1); // beforeDate is exclusive
  } else if (config.toDate) {
    endDate = new Date(config.toDate);
    endDate.setUTCHours(23, 59, 59, 999);
  } else if (config.fromDate && config.toDate) {
    startDate = new Date(config.fromDate);
    startDate.setUTCHours(0, 0, 0, 0);
    endDate = new Date(config.toDate);
    endDate.setUTCHours(23, 59, 59, 999);
  } else if (config.afterDate) {
    startDate = new Date(config.afterDate);
    startDate.setUTCHours(23, 59, 59, 999);
  }
  
  return { startDate, endDate };
}

/**
 * Build WHERE clause for date filtering
 */
function buildWhereClause(startDate: Date | null, endDate: Date | null): { whereClause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;
  
  if (startDate) {
    conditions.push(`timestamp >= $${paramIndex}`);
    params.push(startDate);
    paramIndex++;
  }
  
  if (endDate) {
    conditions.push(`timestamp <= $${paramIndex}`);
    params.push(endDate);
    paramIndex++;
  }
  
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

/**
 * Count records to be deleted
 */
async function countRecordsToDelete(
  pool: Pool,
  startDate: Date | null,
  endDate: Date | null
): Promise<{
  transactions: number;
  logs: number;
  contracts: number;
  internalTransactions: number;
}> {
  const client = await pool.connect();
  try {
    const { whereClause, params } = buildWhereClause(startDate, endDate);
    
    // Count transactions
    const transactionResult = await client.query(
      `SELECT COUNT(*) as count FROM transaction ${whereClause}`,
      params
    );
    const transactions = parseInt(transactionResult.rows[0].count);
    
    if (transactions === 0) {
      return { transactions: 0, logs: 0, contracts: 0, internalTransactions: 0 };
    }
    
    // Count related records
    const logResult = await client.query(
      `SELECT COUNT(*) as count FROM log WHERE transaction_id IN (SELECT id FROM transaction ${whereClause})`,
      params
    );
    
    const contractResult = await client.query(
      `SELECT COUNT(*) as count FROM contract WHERE creation_transaction_id IN (SELECT id FROM transaction ${whereClause})`,
      params
    );
    
    const internalTxResult = await client.query(
      `SELECT COUNT(*) as count FROM internal_transaction WHERE transaction_id IN (SELECT id FROM transaction ${whereClause})`,
      params
    );
    
    return {
      transactions,
      logs: parseInt(logResult.rows[0].count),
      contracts: parseInt(contractResult.rows[0].count),
      internalTransactions: parseInt(internalTxResult.rows[0].count)
    };
  } finally {
    client.release();
  }
}

/**
 * Perform cascade delete in correct order
 */
async function cascadeDeleteTransactions(
  pool: Pool,
  startDate: Date | null,
  endDate: Date | null,
  config: CascadePruneConfig
): Promise<{
  transactionsDeleted: number;
  logsDeleted: number;
  contractsDeleted: number;
  internalTransactionsDeleted: number;
  totalDuration: number;
}> {
  const { whereClause, params } = buildWhereClause(startDate, endDate);
  
  if (config.dryRun) {
    logger.info('[DRY RUN] Would execute cascade deletion');
    return { transactionsDeleted: 0, logsDeleted: 0, contractsDeleted: 0, internalTransactionsDeleted: 0, totalDuration: 0 };
  }
  
  const client = await pool.connect();
  const overallStartTime = Date.now();
  
  try {
    logger.info('🔥 Starting cascade deletion process...');
    
    // Step 1: Delete logs
    logger.info('1️⃣ Deleting logs...');
    const logStartTime = Date.now();
    const logDeleteResult = await client.query(
      `DELETE FROM log WHERE transaction_id IN (SELECT id FROM transaction ${whereClause})`,
      params
    );
    const logsDeleted = logDeleteResult.rowCount || 0;
    const logDuration = Date.now() - logStartTime;
    logger.info(`✅ Deleted ${logsDeleted} logs in ${Math.round(logDuration/1000)}s`);
    
    // Step 2: Delete contracts
    logger.info('2️⃣ Deleting contracts...');
    const contractStartTime = Date.now();
    const contractDeleteResult = await client.query(
      `DELETE FROM contract WHERE creation_transaction_id IN (SELECT id FROM transaction ${whereClause})`,
      params
    );
    const contractsDeleted = contractDeleteResult.rowCount || 0;
    const contractDuration = Date.now() - contractStartTime;
    logger.info(`✅ Deleted ${contractsDeleted} contracts in ${Math.round(contractDuration/1000)}s`);
    
    // Step 3: Delete internal transactions
    logger.info('3️⃣ Deleting internal transactions...');
    const internalTxStartTime = Date.now();
    const internalTxDeleteResult = await client.query(
      `DELETE FROM internal_transaction WHERE transaction_id IN (SELECT id FROM transaction ${whereClause})`,
      params
    );
    const internalTransactionsDeleted = internalTxDeleteResult.rowCount || 0;
    const internalTxDuration = Date.now() - internalTxStartTime;
    logger.info(`✅ Deleted ${internalTransactionsDeleted} internal transactions in ${Math.round(internalTxDuration/1000)}s`);
    
    // Step 4: Delete transactions
    logger.info('4️⃣ Deleting transactions...');
    const transactionStartTime = Date.now();
    const transactionDeleteResult = await client.query(
      `DELETE FROM transaction ${whereClause}`,
      params
    );
    const transactionsDeleted = transactionDeleteResult.rowCount || 0;
    const transactionDuration = Date.now() - transactionStartTime;
    logger.info(`✅ Deleted ${transactionsDeleted} transactions in ${Math.round(transactionDuration/1000)}s`);
    
    const totalDuration = Date.now() - overallStartTime;
    
    return {
      transactionsDeleted,
      logsDeleted,
      contractsDeleted,
      internalTransactionsDeleted,
      totalDuration
    };
    
  } finally {
    client.release();
  }
}

/**
 * Get user confirmation
 */
async function getConfirmation(config: CascadePruneConfig): Promise<boolean> {
  if (config.confirm) {
    return true;
  }
  
  const { startDate, endDate } = getDateRange(config);
  
  console.log('\n=== CASCADE TRANSACTION PRUNING OPERATION SUMMARY ===');
  console.log(`Database URL: ${config.databaseUrl}`);
  console.log(`Batch Size: ${config.batchSize}`);
  console.log(`Dry Run: ${config.dryRun}`);
  
  if (startDate && endDate) {
    console.log(`Date Range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
  } else if (endDate) {
    console.log(`Delete transactions up to: ${endDate.toISOString()}`);
  } else if (startDate) {
    console.log(`Delete transactions from: ${startDate.toISOString()}`);
  }
  
  console.log('\n🚀 CASCADE OPERATION STRATEGY:');
  console.log('   1. Delete logs referencing transactions');
  console.log('   2. Delete contracts referencing transactions');
  console.log('   3. Delete internal_transactions referencing transactions');
  console.log('   4. Delete transactions');
  console.log('   • No FK constraint dropping required');
  console.log('   • Respects referential integrity');
  
  console.log('\n⚠️  WARNING: This will cascade delete all related data!');
  console.log('   • Fast bulk operations (minutes vs hours)');
  console.log('   • Maintains referential integrity throughout');
  console.log('   • Make sure you have a backup before proceeding');
  
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
    rl.question('\nDo you want to proceed with cascade deletion? (yes/no): ', (answer: string) => {
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
    const config: CascadePruneConfig = { ...DEFAULT_CONFIG, ...userConfig };
    
    // Validate configuration
    const { startDate, endDate } = getDateRange(config);
    
    if (!startDate && !endDate) {
      throw new Error('At least one date option must be provided (--before-date, --after-date, --from-date, --to-date)');
    }
    
    // Get user confirmation
    const confirmed = await getConfirmation(config);
    if (!confirmed) {
      logger.info('Operation cancelled by user');
      return;
    }
    
    logger.info('Starting cascade transaction pruning operation', {
      dateRange: startDate && endDate ? 
        `${startDate.toISOString()} to ${endDate.toISOString()}` :
        endDate ? `up to ${endDate.toISOString()}` :
        `from ${startDate?.toISOString()}`,
      batchSize: config.batchSize,
      dryRun: config.dryRun
    });
    
    // Create connection pool
    const pool = createConnectionPool(config.databaseUrl);
    
    try {
      const overallStartTime = Date.now();
      
      // Count records to be deleted
      logger.info('📊 Counting records to delete...');
      const counts = await countRecordsToDelete(pool, startDate, endDate);
      
      if (counts.transactions === 0) {
        logger.info('No transactions found to delete');
        return;
      }
      
      logger.info('Found records to delete:', counts);
      const totalRecords = counts.transactions + counts.logs + counts.contracts + counts.internalTransactions;
      logger.info(`Total records to delete: ${totalRecords}`);
      
      // Perform cascade deletion
      const deleteResult = await cascadeDeleteTransactions(pool, startDate, endDate, config);
      
      const overallDuration = Date.now() - overallStartTime;
      
      logger.info('✅ Cascade transaction pruning completed successfully', {
        transactionsDeleted: deleteResult.transactionsDeleted,
        logsDeleted: deleteResult.logsDeleted,
        contractsDeleted: deleteResult.contractsDeleted,
        internalTransactionsDeleted: deleteResult.internalTransactionsDeleted,
        totalDeleted: deleteResult.transactionsDeleted + deleteResult.logsDeleted + deleteResult.contractsDeleted + deleteResult.internalTransactionsDeleted,
        totalDuration: `${Math.round(overallDuration / 1000)}s`,
        averageRecordsPerSecond: overallDuration > 0 ? Math.round(totalRecords / (overallDuration / 1000)) : 'N/A'
      });
      
    } finally {
      await pool.end();
      logger.info('Database connection closed');
    }
    
  } catch (error) {
    logger.error('❌ Cascade transaction pruning failed', {
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