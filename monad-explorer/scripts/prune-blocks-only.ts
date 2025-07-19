#!/usr/bin/env tsx

import { Pool } from 'pg';
import { logger } from '../src/utils/logger';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration for block-only pruning operations
 */
interface BlockOnlyPruneConfig {
  // Date range options
  beforeDate?: string;
  afterDate?: string;
  fromDate?: string;
  toDate?: string;
  
  // Block range options (alternative to date)
  beforeBlock?: number;
  afterBlock?: number;
  fromBlock?: number;
  toBlock?: number;
  
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
const DEFAULT_CONFIG: BlockOnlyPruneConfig = {
  batchSize: 100000, // Process 100K blocks at a time
  dryRun: false,
  confirm: false,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<BlockOnlyPruneConfig> {
  const args = process.argv.slice(2);
  const config: Partial<BlockOnlyPruneConfig> = {};
  
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
      case '--before-block':
        config.beforeBlock = parseInt(value);
        break;
      case '--after-block':
        config.afterBlock = parseInt(value);
        break;
      case '--from-block':
        config.fromBlock = parseInt(value);
        break;
      case '--to-block':
        config.toBlock = parseInt(value);
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
 * Get filtering criteria for blocks
 */
function getFilterCriteria(config: BlockOnlyPruneConfig): { 
  whereClause: string; 
  params: any[];
  description: string;
} {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;
  let description = '';
  
  // Date-based filtering
  if (config.beforeDate) {
    const endDate = new Date(config.beforeDate);
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setDate(endDate.getDate() - 1);
    conditions.push(`timestamp <= $${paramIndex}`);
    params.push(endDate);
    description = `before ${config.beforeDate}`;
    paramIndex++;
  } else if (config.toDate) {
    const endDate = new Date(config.toDate);
    endDate.setUTCHours(23, 59, 59, 999);
    conditions.push(`timestamp <= $${paramIndex}`);
    params.push(endDate);
    description = `up to ${config.toDate}`;
    paramIndex++;
  } else if (config.fromDate && config.toDate) {
    const startDate = new Date(config.fromDate);
    startDate.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(config.toDate);
    endDate.setUTCHours(23, 59, 59, 999);
    conditions.push(`timestamp >= $${paramIndex}`);
    params.push(startDate);
    paramIndex++;
    conditions.push(`timestamp <= $${paramIndex}`);
    params.push(endDate);
    description = `from ${config.fromDate} to ${config.toDate}`;
    paramIndex++;
  } else if (config.afterDate) {
    const startDate = new Date(config.afterDate);
    startDate.setUTCHours(23, 59, 59, 999);
    conditions.push(`timestamp >= $${paramIndex}`);
    params.push(startDate);
    description = `after ${config.afterDate}`;
    paramIndex++;
  }
  
  // Block number-based filtering
  if (config.beforeBlock) {
    conditions.push(`number < $${paramIndex}`);
    params.push(config.beforeBlock);
    description += (description ? ' and ' : '') + `before block ${config.beforeBlock}`;
    paramIndex++;
  } else if (config.toBlock) {
    conditions.push(`number <= $${paramIndex}`);
    params.push(config.toBlock);
    description += (description ? ' and ' : '') + `up to block ${config.toBlock}`;
    paramIndex++;
  } else if (config.fromBlock && config.toBlock) {
    conditions.push(`number >= $${paramIndex}`);
    params.push(config.fromBlock);
    paramIndex++;
    conditions.push(`number <= $${paramIndex}`);
    params.push(config.toBlock);
    description += (description ? ' and ' : '') + `from block ${config.fromBlock} to ${config.toBlock}`;
    paramIndex++;
  } else if (config.afterBlock) {
    conditions.push(`number > $${paramIndex}`);
    params.push(config.afterBlock);
    description += (description ? ' and ' : '') + `after block ${config.afterBlock}`;
    paramIndex++;
  }
  
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params, description };
}

/**
 * Count blocks and affected transactions
 */
async function countRecordsToProcess(
  pool: Pool,
  config: BlockOnlyPruneConfig
): Promise<{
  blocks: number;
  affectedTransactions: number;
}> {
  const client = await pool.connect();
  try {
    const { whereClause, params } = getFilterCriteria(config);
    
    // Count blocks
    const blockResult = await client.query(
      `SELECT COUNT(*) as count FROM block ${whereClause}`,
      params
    );
    const blocks = parseInt(blockResult.rows[0].count);
    
    if (blocks === 0) {
      return { blocks: 0, affectedTransactions: 0 };
    }
    
    // Count transactions that reference these blocks
    const transactionResult = await client.query(
      `SELECT COUNT(*) as count FROM transaction WHERE block_id IN (SELECT id FROM block ${whereClause})`,
      params
    );
    const affectedTransactions = parseInt(transactionResult.rows[0].count);
    
    return { blocks, affectedTransactions };
  } finally {
    client.release();
  }
}

/**
 * Perform block-only deletion (unlink transactions, then delete blocks)
 */
async function deleteBlocksOnly(
  pool: Pool,
  config: BlockOnlyPruneConfig
): Promise<{
  blocksDeleted: number;
  transactionsUnlinked: number;
  totalDuration: number;
}> {
  const { whereClause, params } = getFilterCriteria(config);
  
  if (config.dryRun) {
    logger.info('[DRY RUN] Would execute block-only deletion');
    return { blocksDeleted: 0, transactionsUnlinked: 0, totalDuration: 0 };
  }
  
  const client = await pool.connect();
  const overallStartTime = Date.now();
  
  try {
    logger.info('🔥 Starting block-only deletion process...');
    
    // Step 1: Unlink transactions from target blocks (set block_id to NULL)
    logger.info('1️⃣ Unlinking transactions from target blocks...');
    const unlinkStartTime = Date.now();
    const unlinkResult = await client.query(
      `UPDATE transaction SET block_id = NULL WHERE block_id IN (SELECT id FROM block ${whereClause})`,
      params
    );
    const transactionsUnlinked = unlinkResult.rowCount || 0;
    const unlinkDuration = Date.now() - unlinkStartTime;
    logger.info(`✅ Unlinked ${transactionsUnlinked} transactions in ${Math.round(unlinkDuration/1000)}s`);
    
    // Step 2: Delete target blocks
    logger.info('2️⃣ Deleting blocks...');
    const blockStartTime = Date.now();
    const blockDeleteResult = await client.query(
      `DELETE FROM block ${whereClause}`,
      params
    );
    const blocksDeleted = blockDeleteResult.rowCount || 0;
    const blockDuration = Date.now() - blockStartTime;
    logger.info(`✅ Deleted ${blocksDeleted} blocks in ${Math.round(blockDuration/1000)}s`);
    
    const totalDuration = Date.now() - overallStartTime;
    
    return {
      blocksDeleted,
      transactionsUnlinked,
      totalDuration
    };
    
  } finally {
    client.release();
  }
}

/**
 * Get user confirmation
 */
async function getConfirmation(config: BlockOnlyPruneConfig): Promise<boolean> {
  if (config.confirm) {
    return true;
  }
  
  const { description } = getFilterCriteria(config);
  
  console.log('\n=== BLOCK-ONLY PRUNING OPERATION SUMMARY ===');
  console.log(`Database URL: ${config.databaseUrl}`);
  console.log(`Batch Size: ${config.batchSize}`);
  console.log(`Dry Run: ${config.dryRun}`);
  console.log(`Target: Blocks ${description}`);
  
  console.log('\n🚀 BLOCK-ONLY OPERATION STRATEGY:');
  console.log('   1. Set block_id = NULL for transactions in target blocks');
  console.log('   2. Delete target blocks');
  console.log('   • Transactions remain intact (just unlinked from blocks)');
  console.log('   • All transaction data preserved (logs, contracts, etc.)');
  console.log('   • Very fast operation (no cascade deletes)');
  
  console.log('\n⚠️  WARNING: This will unlink transactions from their blocks!');
  console.log('   • Transactions will have block_id = NULL');
  console.log('   • Block metadata will be lost');
  console.log('   • Transaction data remains fully intact');
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
    rl.question('\nDo you want to proceed with block-only deletion? (yes/no): ', (answer: string) => {
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
    const config: BlockOnlyPruneConfig = { ...DEFAULT_CONFIG, ...userConfig };
    
    // Validate configuration
    const hasDateOption = config.beforeDate || config.afterDate || config.fromDate || config.toDate;
    const hasBlockOption = config.beforeBlock || config.afterBlock || config.fromBlock || config.toBlock;
    
    if (!hasDateOption && !hasBlockOption) {
      throw new Error('At least one filtering option must be provided (date options or block number options)');
    }
    
    // Get user confirmation
    const confirmed = await getConfirmation(config);
    if (!confirmed) {
      logger.info('Operation cancelled by user');
      return;
    }
    
    const { description } = getFilterCriteria(config);
    
    logger.info('Starting block-only pruning operation', {
      target: `Blocks ${description}`,
      batchSize: config.batchSize,
      dryRun: config.dryRun
    });
    
    // Create connection pool
    const pool = createConnectionPool(config.databaseUrl);
    
    try {
      const overallStartTime = Date.now();
      
      // Count records to be processed
      logger.info('📊 Counting blocks and affected transactions...');
      const counts = await countRecordsToProcess(pool, config);
      
      if (counts.blocks === 0) {
        logger.info('No blocks found to delete');
        return;
      }
      
      logger.info('Found records to process:', counts);
      logger.info(`Operation: Unlink ${counts.affectedTransactions} transactions, delete ${counts.blocks} blocks`);
      
      // Perform block-only deletion
      const deleteResult = await deleteBlocksOnly(pool, config);
      
      const overallDuration = Date.now() - overallStartTime;
      
      logger.info('✅ Block-only pruning completed successfully', {
        blocksDeleted: deleteResult.blocksDeleted,
        transactionsUnlinked: deleteResult.transactionsUnlinked,
        totalDuration: `${Math.round(overallDuration / 1000)}s`,
        blocksPerSecond: overallDuration > 0 ? Math.round(deleteResult.blocksDeleted / (overallDuration / 1000)) : 'N/A',
        transactionsPerSecond: overallDuration > 0 ? Math.round(deleteResult.transactionsUnlinked / (overallDuration / 1000)) : 'N/A'
      });
      
    } finally {
      await pool.end();
      logger.info('Database connection closed');
    }
    
  } catch (error) {
    logger.error('❌ Block-only pruning failed', {
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