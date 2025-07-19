#!/usr/bin/env tsx

import { Pool } from 'pg';
import { logger } from '../src/utils/logger';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration for truncate pruning operations
 */
interface TruncatePruneConfig {
  // Date range options  
  beforeDate?: string;
  afterDate?: string;
  fromDate?: string;
  toDate?: string;
  
  // Processing options
  dryRun: boolean;
  confirm: boolean;
  
  // Database connection
  databaseUrl: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: TruncatePruneConfig = {
  dryRun: false,
  confirm: false,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Table processing order (reverse dependency order)
 */
const TABLES_TO_PROCESS = [
  'daily_stats',      // Independent table
  'log',              // References transaction
  'contract',         // References transaction  
  'internal_transaction', // References transaction
  'transaction',      // References block
  'block'            // Independent (or keep all blocks)
];

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<TruncatePruneConfig> {
  const args = process.argv.slice(2);
  const config: Partial<TruncatePruneConfig> = {};
  
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
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

/**
 * Get date range for pruning
 */
function getDateRange(config: TruncatePruneConfig): { startDate: Date | null; endDate: Date | null } {
  let startDate: Date | null = null;
  let endDate: Date | null = null;
  
  if (config.beforeDate) {
    endDate = new Date(config.beforeDate);
    endDate.setUTCHours(0, 0, 0, 0);
    endDate.setDate(endDate.getDate() - 1);
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
 * Build WHERE clause for keeping data (opposite of deletion)
 */
function buildKeepWhereClause(startDate: Date | null, endDate: Date | null): { whereClause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;
  
  // Keep data AFTER the end date (opposite of deletion)
  if (endDate) {
    conditions.push(`timestamp > $${paramIndex}`);
    params.push(endDate);
    paramIndex++;
  }
  
  // For from/to range, this would be more complex, but for now assume we're keeping after toDate
  
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

/**
 * Count records before operation
 */
async function countCurrentRecords(pool: Pool): Promise<Record<string, number>> {
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  
  try {
    for (const table of TABLES_TO_PROCESS) {
      const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      counts[table] = parseInt(result.rows[0].count);
    }
    return counts;
  } finally {
    client.release();
  }
}

/**
 * Count records to keep
 */
async function countRecordsToKeep(
  pool: Pool, 
  startDate: Date | null, 
  endDate: Date | null
): Promise<Record<string, number>> {
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  
  try {
    const { whereClause, params } = buildKeepWhereClause(startDate, endDate);
    
    // For tables with timestamp
    const timestampTables = ['transaction', 'block'];
    for (const table of timestampTables) {
      const result = await client.query(`SELECT COUNT(*) as count FROM ${table} ${whereClause}`, params);
      counts[table] = parseInt(result.rows[0].count);
    }
    
    // For tables without direct timestamp (use transaction reference)
    if (counts.transaction > 0) {
      const logResult = await client.query(
        `SELECT COUNT(*) as count FROM log WHERE transaction_id IN (SELECT id FROM transaction ${whereClause})`,
        params
      );
      counts.log = parseInt(logResult.rows[0].count);
      
      const contractResult = await client.query(
        `SELECT COUNT(*) as count FROM contract WHERE creation_transaction_id IN (SELECT id FROM transaction ${whereClause})`,
        params
      );
      counts.contract = parseInt(contractResult.rows[0].count);
      
      const internalTxResult = await client.query(
        `SELECT COUNT(*) as count FROM internal_transaction WHERE transaction_id IN (SELECT id FROM transaction ${whereClause})`,
        params
      );
      counts.internal_transaction = parseInt(internalTxResult.rows[0].count);
    } else {
      counts.log = 0;
      counts.contract = 0;
      counts.internal_transaction = 0;
    }
    
    // Daily stats - keep all or none based on your needs
    counts.daily_stats = 0; // We'll recreate this anyway
    
    return counts;
  } finally {
    client.release();
  }
}

/**
 * Backup data to keep in temp tables
 */
async function backupDataToKeep(
  pool: Pool,
  startDate: Date | null,
  endDate: Date | null,
  dryRun: boolean
): Promise<Record<string, number>> {
  const client = await pool.connect();
  const backedUpCounts: Record<string, number> = {};
  
  try {
    const { whereClause, params } = buildKeepWhereClause(startDate, endDate);
    
    logger.info('💾 Creating backup temp tables...');
    
    // Create temp tables and backup data
    const backupOperations = [
      {
        table: 'transaction',
        sql: `CREATE TEMP TABLE temp_transaction AS SELECT * FROM transaction ${whereClause}`
      },
      {
        table: 'block', 
        sql: `CREATE TEMP TABLE temp_block AS SELECT * FROM block ${whereClause}`
      },
      {
        table: 'log',
        sql: `CREATE TEMP TABLE temp_log AS SELECT l.* FROM log l WHERE l.transaction_id IN (SELECT id FROM transaction ${whereClause})`
      },
      {
        table: 'contract',
        sql: `CREATE TEMP TABLE temp_contract AS SELECT c.* FROM contract c WHERE c.creation_transaction_id IN (SELECT id FROM transaction ${whereClause})`
      },
      {
        table: 'internal_transaction',
        sql: `CREATE TEMP TABLE temp_internal_transaction AS SELECT it.* FROM internal_transaction it WHERE it.transaction_id IN (SELECT id FROM transaction ${whereClause})`
      }
    ];
    
    for (const op of backupOperations) {
      if (dryRun) {
        logger.info(`[DRY RUN] Would create: temp_${op.table}`);
        backedUpCounts[op.table] = 0;
      } else {
        const startTime = Date.now();
        await client.query(op.sql, params);
        
        // Count backed up records
        const countResult = await client.query(`SELECT COUNT(*) as count FROM temp_${op.table}`);
        const count = parseInt(countResult.rows[0].count);
        backedUpCounts[op.table] = count;
        
        const duration = Date.now() - startTime;
        logger.info(`✅ Backed up ${count} ${op.table} records in ${Math.round(duration/1000)}s`);
      }
    }
    
    return backedUpCounts;
  } finally {
    client.release();
  }
}

/**
 * Truncate all tables
 */
async function truncateAllTables(pool: Pool, dryRun: boolean): Promise<void> {
  const client = await pool.connect();
  
  try {
    logger.info('🗑️ Truncating tables...');
    
    if (dryRun) {
      logger.info('[DRY RUN] Would truncate all tables');
      return;
    }
    
    // Disable triggers and constraints temporarily
    await client.query('SET session_replication_role = replica');
    
    // Truncate in dependency order (reverse of TABLES_TO_PROCESS)
    const truncateOrder = [...TABLES_TO_PROCESS].reverse();
    
    for (const table of truncateOrder) {
      const startTime = Date.now();
      await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
      const duration = Date.now() - startTime;
      logger.info(`✅ Truncated ${table} in ${Math.round(duration/1000)}s`);
    }
    
    // Re-enable triggers and constraints
    await client.query('SET session_replication_role = DEFAULT');
    
  } finally {
    client.release();
  }
}

/**
 * Restore data from temp tables
 */
async function restoreDataFromTemp(pool: Pool, dryRun: boolean): Promise<Record<string, number>> {
  const client = await pool.connect();
  const restoredCounts: Record<string, number> = {};
  
  try {
    logger.info('📥 Restoring data from temp tables...');
    
    if (dryRun) {
      logger.info('[DRY RUN] Would restore all data');
      return {};
    }
    
    // Restore in dependency order
    const restoreOrder = ['block', 'transaction', 'log', 'contract', 'internal_transaction'];
    
    for (const table of restoreOrder) {
      const startTime = Date.now();
      
      // Check if temp table exists and has data
      const checkResult = await client.query(`
        SELECT COUNT(*) as count FROM temp_${table}
      `).catch(() => ({ rows: [{ count: '0' }] }));
      
      const tempCount = parseInt(checkResult.rows[0].count);
      
      if (tempCount > 0) {
        await client.query(`INSERT INTO ${table} SELECT * FROM temp_${table}`);
        restoredCounts[table] = tempCount;
        
        const duration = Date.now() - startTime;
        logger.info(`✅ Restored ${tempCount} ${table} records in ${Math.round(duration/1000)}s`);
      } else {
        logger.info(`⚪ No data to restore for ${table}`);
        restoredCounts[table] = 0;
      }
    }
    
    return restoredCounts;
  } finally {
    client.release();
  }
}

/**
 * Get user confirmation
 */
async function getConfirmation(config: TruncatePruneConfig): Promise<boolean> {
  if (config.confirm) {
    return true;
  }
  
  const { startDate, endDate } = getDateRange(config);
  
  console.log('\n=== TRUNCATE TRANSACTION PRUNING OPERATION SUMMARY ===');
  console.log(`Database URL: ${config.databaseUrl}`);
  console.log(`Dry Run: ${config.dryRun}`);
  
  if (endDate) {
    console.log(`Delete transactions up to: ${endDate.toISOString()}`);
    console.log(`Keep transactions after: ${endDate.toISOString()}`);
  }
  
  console.log('\n🚀 TRUNCATE OPERATION STRATEGY:');
  console.log('   1. Backup data to keep in temp tables');
  console.log('   2. TRUNCATE all tables (instant)');
  console.log('   3. Restore kept data from temp tables');
  console.log('   • Fastest method for large deletions');
  console.log('   • Requires sufficient RAM for temp tables');
  console.log('   • Resets auto-increment sequences');
  
  console.log('\n⚠️  WARNING: This is the most aggressive pruning method!');
  console.log('   • Much faster than cascade delete (minutes vs hours)');
  console.log('   • Temporarily truncates entire tables');
  console.log('   • Requires good backup - this is destructive!');
  
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
    rl.question('\nDo you want to proceed with TRUNCATE method? (yes/no): ', (answer: string) => {
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
    const config: TruncatePruneConfig = { ...DEFAULT_CONFIG, ...userConfig };
    
    // Validate configuration
    const { startDate, endDate } = getDateRange(config);
    
    if (!endDate) {
      throw new Error('TRUNCATE method requires an end date (--before-date or --to-date)');
    }
    
    // Get user confirmation
    const confirmed = await getConfirmation(config);
    if (!confirmed) {
      logger.info('Operation cancelled by user');
      return;
    }
    
    logger.info('Starting TRUNCATE transaction pruning operation', {
      keepDataAfter: endDate.toISOString(),
      dryRun: config.dryRun
    });
    
    // Create connection pool
    const pool = createConnectionPool(config.databaseUrl);
    
    try {
      const overallStartTime = Date.now();
      
      // Count current records
      logger.info('📊 Counting current records...');
      const currentCounts = await countCurrentRecords(pool);
      logger.info('Current record counts:', currentCounts);
      
      // Count records to keep
      logger.info('📊 Counting records to keep...');
      const keepCounts = await countRecordsToKeep(pool, startDate, endDate);
      logger.info('Records to keep:', keepCounts);
      
      // Calculate what will be deleted
      const deleteCounts: Record<string, number> = {};
      for (const table of TABLES_TO_PROCESS) {
        deleteCounts[table] = (currentCounts[table] || 0) - (keepCounts[table] || 0);
      }
      logger.info('Records to delete:', deleteCounts);
      
      const totalToDelete = Object.values(deleteCounts).reduce((sum, count) => sum + count, 0);
      const totalToKeep = Object.values(keepCounts).reduce((sum, count) => sum + count, 0);
      
      logger.info(`Total records: ${totalToDelete + totalToKeep}, Deleting: ${totalToDelete}, Keeping: ${totalToKeep}`);
      
      if (totalToDelete === 0) {
        logger.info('No records to delete');
        return;
      }
      
      // Step 1: Backup data to keep
      const backedUpCounts = await backupDataToKeep(pool, startDate, endDate, config.dryRun);
      
      // Step 2: Truncate all tables
      await truncateAllTables(pool, config.dryRun);
      
      // Step 3: Restore kept data
      const restoredCounts = await restoreDataFromTemp(pool, config.dryRun);
      
      const overallDuration = Date.now() - overallStartTime;
      
      logger.info('✅ TRUNCATE transaction pruning completed successfully', {
        totalRecordsDeleted: totalToDelete,
        totalRecordsKept: totalToKeep,
        totalDuration: `${Math.round(overallDuration / 1000)}s`,
        averageRecordsPerSecond: overallDuration > 0 ? Math.round(totalToDelete / (overallDuration / 1000)) : 'N/A',
        backedUpCounts,
        restoredCounts
      });
      
    } finally {
      await pool.end();
      logger.info('Database connection closed');
    }
    
  } catch (error) {
    logger.error('❌ TRUNCATE transaction pruning failed', {
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