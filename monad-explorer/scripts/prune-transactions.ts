#!/usr/bin/env tsx

// Increase Node.js heap size for large pruning operations
if (process.env.NODE_OPTIONS && !process.env.NODE_OPTIONS.includes('--max-old-space-size')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS} --max-old-space-size=8192`;
} else if (!process.env.NODE_OPTIONS) {
  process.env.NODE_OPTIONS = '--max-old-space-size=8192';
}

import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { Transaction, Block, DailyStats, Log } from '../src/model/generated';
import { logger } from '../src/utils/logger';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration for pruning operations
 */
interface PruneConfig {
  // Date range options (mutually exclusive with count)
  beforeDate?: string; // YYYY-MM-DD format - delete transactions before this date
  afterDate?: string;  // YYYY-MM-DD format - delete transactions after this date
  fromDate?: string;   // YYYY-MM-DD format - delete transactions from this date
  toDate?: string;     // YYYY-MM-DD format - delete transactions up to this date
  
  // Count option (mutually exclusive with date options)
  keepCount?: number;       // Keep the latest N transactions, delete the rest
  
  // Processing options
  batchSize: number;        // Number of transactions to delete per batch
  concurrency: number;      // Number of concurrent deletion operations
  dryRun: boolean;          // Show what would be deleted without actually deleting
  confirm: boolean;         // Skip confirmation prompt
  enableGc: boolean;        // Enable garbage collection
  
  // Database connection
  databaseUrl: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: PruneConfig = {
  batchSize: 10000,         // Delete 10k transactions at a time
  concurrency: 2,           // 2 concurrent deletion operations
  dryRun: false,
  confirm: false,
  enableGc: false,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/monad_explorer'
};

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<PruneConfig> {
  const args = process.argv.slice(2);
  const config: Partial<PruneConfig> = {};
  
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
      case '--concurrency':
        config.concurrency = parseInt(value);
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
 * Initialize database connection
 */
async function createDataSource(databaseUrl: string): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [Transaction, Block, DailyStats, Log],
    logging: false,
    synchronize: false,
    namingStrategy: new SnakeNamingStrategy()
  });
  
  await dataSource.initialize();
  logger.info('Database connection established');
  
  return dataSource;
}

/**
 * Get date range for pruning based on configuration
 */
function getDateRange(config: PruneConfig): { startDate: Date | null; endDate: Date | null } {
  let startDate: Date | null = null;
  let endDate: Date | null = null;
  
  if (config.beforeDate) {
    endDate = new Date(config.beforeDate);
    endDate.setUTCHours(0, 0, 0, 0);
  }
  
  if (config.afterDate) {
    startDate = new Date(config.afterDate);
    startDate.setUTCHours(23, 59, 59, 999);
  }
  
  if (config.fromDate) {
    startDate = new Date(config.fromDate);
    startDate.setUTCHours(0, 0, 0, 0);
  }
  
  if (config.toDate) {
    endDate = new Date(config.toDate);
    endDate.setUTCHours(23, 59, 59, 999);
  }
  
  return { startDate, endDate };
}

/**
 * Count transactions in the specified date range
 */
async function countTransactionsToDelete(
  dataSource: DataSource,
  startDate: Date | null,
  endDate: Date | null
): Promise<number> {
  const transactionRepo = dataSource.getRepository(Transaction);
  const queryBuilder = transactionRepo.createQueryBuilder('tx');
  
  if (startDate) {
    queryBuilder.andWhere('tx.timestamp >= :startDate', { startDate });
  }
  
  if (endDate) {
    queryBuilder.andWhere('tx.timestamp <= :endDate', { endDate });
  }
  
  return await queryBuilder.getCount();
}

/**
 * Get total transaction count in database
 */
async function getTotalTransactionCount(dataSource: DataSource): Promise<number> {
  const transactionRepo = dataSource.getRepository(Transaction);
  return await transactionRepo.count();
}

/**
 * Get cutoff timestamp for keeping latest N transactions
 */
async function getCutoffTimestampForCount(
  dataSource: DataSource,
  keepCount: number
): Promise<Date | null> {
  const transactionRepo = dataSource.getRepository(Transaction);
  
  // Get the timestamp of the Nth transaction from the end (sorted by timestamp desc)
  const result = await transactionRepo
    .createQueryBuilder('tx')
    .select('tx.timestamp')
    .orderBy('tx.timestamp', 'DESC')
    .addOrderBy('tx.id', 'DESC') // Secondary sort for consistency
    .limit(1)
    .offset(keepCount - 1) // Get the Nth transaction
    .getOne();
  
  return result ? result.timestamp : null;
}

/**
 * Delete logs associated with transactions in batches
 */
async function deleteLogsForTransactions(
  dataSource: DataSource,
  transactionIds: string[],
  config: PruneConfig
): Promise<number> {
  const logRepo = dataSource.getRepository(Log);
  let totalDeleted = 0;
  
  const batchSize = config.batchSize;
  
  // Process transaction IDs in batches
  for (let i = 0; i < transactionIds.length; i += batchSize) {
    const batchIds = transactionIds.slice(i, i + batchSize);
    
    if (config.dryRun) {
      // Count logs that would be deleted
      const logCount = await logRepo
        .createQueryBuilder('log')
        .where('log.transaction_id IN (:...transactionIds)', { transactionIds: batchIds })
        .getCount();
      
      logger.info(`[DRY RUN] Would delete ${logCount} logs for ${batchIds.length} transactions`);
      totalDeleted += logCount;
    } else {
      // Delete logs
      const deleteResult = await logRepo
        .createQueryBuilder()
        .delete()
        .where('transaction_id IN (:...transactionIds)', { transactionIds: batchIds })
        .execute();
      
      const deletedCount = deleteResult.affected || 0;
      totalDeleted += deletedCount;
      
      logger.info(`Deleted ${deletedCount} logs for ${batchIds.length} transactions`);
    }
    
    // Force garbage collection if enabled
    if (config.enableGc && global.gc) {
      global.gc();
    }
  }
  
  return totalDeleted;
}

/**
 * Delete transactions in batches
 */
async function deleteTransactionsInBatches(
  dataSource: DataSource,
  startDate: Date | null,
  endDate: Date | null,
  config: PruneConfig
): Promise<{ transactionsDeleted: number; logsDeleted: number }> {
  const transactionRepo = dataSource.getRepository(Transaction);
  let totalTransactionsDeleted = 0;
  let totalLogsDeleted = 0;
  
  // Get total count for progress tracking
  const totalCount = await countTransactionsToDelete(dataSource, startDate, endDate);
  
  if (totalCount === 0) {
    logger.info('No transactions found to delete');
    return { transactionsDeleted: 0, logsDeleted: 0 };
  }
  
  logger.info(`Found ${totalCount} transactions to delete`);
  
  // Delete in batches
  let offset = 0;
  const batchSize = config.batchSize;
  
  while (offset < totalCount) {
    // Get batch of transaction IDs to delete
    const queryBuilder = transactionRepo
      .createQueryBuilder('tx')
      .select('tx.id')
      .orderBy('tx.id');
    
    if (startDate) {
      queryBuilder.andWhere('tx.timestamp >= :startDate', { startDate });
    }
    
    if (endDate) {
      queryBuilder.andWhere('tx.timestamp <= :endDate', { endDate });
    }
    
    const transactionIds = await queryBuilder
      .limit(batchSize)
      .offset(offset)
      .getMany();
    
    if (transactionIds.length === 0) {
      break;
    }
    
    const idsToDelete = transactionIds.map(tx => tx.id);
    
    if (config.dryRun) {
      logger.info(`[DRY RUN] Would delete ${idsToDelete.length} transactions (IDs: ${idsToDelete.slice(0, 5).join(', ')}${idsToDelete.length > 5 ? '...' : ''})`);
      
      // Count logs that would be deleted
      const logsDeleted = await deleteLogsForTransactions(dataSource, idsToDelete, config);
      totalLogsDeleted += logsDeleted;
    } else {
      // First delete associated logs
      const logsDeleted = await deleteLogsForTransactions(dataSource, idsToDelete, config);
      totalLogsDeleted += logsDeleted;
      
      // Then delete transactions
      const deleteResult = await transactionRepo
        .createQueryBuilder()
        .delete()
        .whereInIds(idsToDelete)
        .execute();
      
      totalTransactionsDeleted += deleteResult.affected || 0;
      
      logger.info(`Deleted ${deleteResult.affected || 0} transactions and ${logsDeleted} logs (${totalTransactionsDeleted}/${totalCount} transactions total)`);
    }
    
    offset += batchSize;
    
    // Force garbage collection if enabled
    if (config.enableGc && global.gc) {
      global.gc();
    }
  }
  
  return { transactionsDeleted: totalTransactionsDeleted, logsDeleted: totalLogsDeleted };
}

/**
 * Delete transactions older than cutoff timestamp (for count-based pruning)
 */
async function deleteTransactionsOlderThanCutoff(
  dataSource: DataSource,
  cutoffTimestamp: Date,
  config: PruneConfig
): Promise<{ transactionsDeleted: number; logsDeleted: number }> {
  const transactionRepo = dataSource.getRepository(Transaction);
  let totalTransactionsDeleted = 0;
  let totalLogsDeleted = 0;
  
  // Get total count for progress tracking
  const totalCount = await transactionRepo
    .createQueryBuilder('tx')
    .where('tx.timestamp < :cutoffTimestamp', { cutoffTimestamp })
    .getCount();
  
  if (totalCount === 0) {
    logger.info('No transactions found to delete');
    return { transactionsDeleted: 0, logsDeleted: 0 };
  }
  
  logger.info(`Found ${totalCount} transactions to delete (older than ${cutoffTimestamp.toISOString()})`);
  
  // Delete in batches
  let offset = 0;
  const batchSize = config.batchSize;
  
  while (offset < totalCount) {
    // Get batch of transaction IDs to delete
    const transactionIds = await transactionRepo
      .createQueryBuilder('tx')
      .select('tx.id')
      .where('tx.timestamp < :cutoffTimestamp', { cutoffTimestamp })
      .orderBy('tx.id')
      .limit(batchSize)
      .offset(offset)
      .getMany();
    
    if (transactionIds.length === 0) {
      break;
    }
    
    const idsToDelete = transactionIds.map(tx => tx.id);
    
    if (config.dryRun) {
      logger.info(`[DRY RUN] Would delete ${idsToDelete.length} transactions (IDs: ${idsToDelete.slice(0, 5).join(', ')}${idsToDelete.length > 5 ? '...' : ''})`);
      
      // Count logs that would be deleted
      const logsDeleted = await deleteLogsForTransactions(dataSource, idsToDelete, config);
      totalLogsDeleted += logsDeleted;
    } else {
      // First delete associated logs
      const logsDeleted = await deleteLogsForTransactions(dataSource, idsToDelete, config);
      totalLogsDeleted += logsDeleted;
      
      // Then delete transactions
      const deleteResult = await transactionRepo
        .createQueryBuilder()
        .delete()
        .whereInIds(idsToDelete)
        .execute();
      
      totalTransactionsDeleted += deleteResult.affected || 0;
      
      logger.info(`Deleted ${deleteResult.affected || 0} transactions and ${logsDeleted} logs (${totalTransactionsDeleted}/${totalCount} transactions total)`);
    }
    
    offset += batchSize;
    
    // Force garbage collection if enabled
    if (config.enableGc && global.gc) {
      global.gc();
    }
  }
  
  return { transactionsDeleted: totalTransactionsDeleted, logsDeleted: totalLogsDeleted };
}

/**
 * Update daily stats after pruning
 */
async function updateDailyStatsAfterPruning(
  dataSource: DataSource,
  startDate: Date | null,
  endDate: Date | null,
  config: PruneConfig
): Promise<void> {
  if (config.dryRun) {
    logger.info('[DRY RUN] Would update daily stats after pruning');
    return;
  }
  
  logger.info('Updating daily stats after pruning...');
  
  // Get affected date range
  const affectedDates: Date[] = [];
  
  if (startDate && endDate) {
    // Get all dates in the range
    const current = new Date(startDate);
    while (current <= endDate) {
      affectedDates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
  } else if (startDate) {
    // From startDate to today
    const current = new Date(startDate);
    const today = new Date();
    while (current <= today) {
      affectedDates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
  } else if (endDate) {
    // From beginning to endDate
    const current = new Date('2024-01-01'); // Assuming data starts from 2024
    while (current <= endDate) {
      affectedDates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
  }
  
  // Delete affected daily stats
  const dailyStatsRepo = dataSource.getRepository(DailyStats);
  for (const date of affectedDates) {
    const dateStr = date.toISOString().split('T')[0];
    await dailyStatsRepo.delete({ id: dateStr });
    logger.debug(`Deleted daily stats for ${dateStr}`);
  }
  
  logger.info(`Updated daily stats for ${affectedDates.length} days`);
}

/**
 * Validate configuration
 */
function validateConfig(config: PruneConfig): void {
  // Check that at least one option is provided
  const hasDateOption = config.beforeDate || config.afterDate || config.fromDate || config.toDate;
  const hasCountOption = config.keepCount !== undefined;
  
  if (!hasDateOption && !hasCountOption) {
    throw new Error('At least one option must be provided (date options or --keep-count)');
  }
  
  // Check that date and count options are not used together
  if (hasDateOption && hasCountOption) {
    throw new Error('Date options and --keep-count cannot be used together. Use either date-based or count-based pruning.');
  }
  
  // Validate date formats
  const dates = [config.beforeDate, config.afterDate, config.fromDate, config.toDate].filter(Boolean);
  for (const date of dates) {
    if (date && isNaN(new Date(date).getTime())) {
      throw new Error(`Invalid date format: ${date}. Use YYYY-MM-DD format.`);
    }
  }
  
  // Validate count option
  if (config.keepCount !== undefined && config.keepCount < 1) {
    throw new Error('Keep count must be a positive integer.');
  }
  
  // Validate batch size and concurrency
  if (config.batchSize < 1 || config.concurrency < 1) {
    throw new Error('Batch size and concurrency must be positive integers.');
  }
}

/**
 * Display help information
 */
function displayHelp(): void {
  console.log(`
Transaction Pruning Script

Usage:
  npx ts-node scripts/prune-transactions.ts [options]

Options:
  # Date-based pruning (mutually exclusive with count-based)
  --before-date YYYY-MM-DD    Delete transactions before this date
  --after-date YYYY-MM-DD     Delete transactions after this date
  --from-date YYYY-MM-DD      Delete transactions from this date (inclusive)
  --to-date YYYY-MM-DD        Delete transactions up to this date (inclusive)
  
  # Count-based pruning (mutually exclusive with date-based)
  --keep-count N              Keep the latest N transactions, delete the rest
  
  # Processing options
  --batch-size N              Number of transactions to delete per batch (default: 10000)
  --concurrency N             Number of concurrent deletion operations (default: 2)
  --dry-run                   Show what would be deleted without actually deleting
  --confirm                   Skip confirmation prompt
  --enable-gc                 Enable garbage collection for memory management
  --database-url URL          Database connection URL
  --help                      Display this help message

Examples:
  # Date-based pruning
  # Delete transactions before 2024-06-01
  npx ts-node scripts/prune-transactions.ts --before-date 2024-06-01

  # Delete transactions from 2024-01-01 to 2024-03-31
  npx ts-node scripts/prune-transactions.ts --from-date 2024-01-01 --to-date 2024-03-31

  # Delete transactions after 2024-12-01
  npx ts-node scripts/prune-transactions.ts --after-date 2024-12-01

  # Count-based pruning
  # Keep only the latest 5000 transactions
  npx ts-node scripts/prune-transactions.ts --keep-count 5000

  # Keep only the latest 10000 transactions (dry run first)
  npx ts-node scripts/prune-transactions.ts --keep-count 10000 --dry-run

  # General options
  # Dry run to see what would be deleted
  npx ts-node scripts/prune-transactions.ts --before-date 2024-06-01 --dry-run

  # Use smaller batches for large deletions
  npx ts-node scripts/prune-transactions.ts --before-date 2024-06-01 --batch-size 5000 --concurrency 1

  # Enable garbage collection for memory management
  npx ts-node scripts/prune-transactions.ts --before-date 2024-06-01 --enable-gc
  `);
}

/**
 * Get user confirmation
 */
async function getConfirmation(config: PruneConfig): Promise<boolean> {
  if (config.confirm) {
    return true;
  }
  
  const { startDate, endDate } = getDateRange(config);
  
  console.log('\n=== PRUNING OPERATION SUMMARY ===');
  console.log(`Database URL: ${config.databaseUrl}`);
  console.log(`Batch Size: ${config.batchSize}`);
  console.log(`Concurrency: ${config.concurrency}`);
  console.log(`Dry Run: ${config.dryRun}`);
  
  if (startDate) {
    console.log(`Start Date: ${startDate.toISOString()}`);
  }
  if (endDate) {
    console.log(`End Date: ${endDate.toISOString()}`);
  }
  
  if (config.beforeDate) {
    console.log(`Will delete transactions BEFORE: ${config.beforeDate}`);
  }
  if (config.afterDate) {
    console.log(`Will delete transactions AFTER: ${config.afterDate}`);
  }
  if (config.fromDate && config.toDate) {
    console.log(`Will delete transactions FROM: ${config.fromDate} TO: ${config.toDate}`);
  }
  if (config.keepCount !== undefined) {
    console.log(`Will keep the latest ${config.keepCount} transactions`);
  }
  
  console.log('\n⚠️  WARNING: This operation will permanently delete data!');
  console.log('   Make sure you have a backup before proceeding.');
  
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
    rl.question('\nDo you want to proceed? (yes/no): ', (answer: string) => {
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
    // Check for help flag
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      displayHelp();
      return;
    }
    
    // Parse configuration
    const userConfig = parseArgs();
    const config: PruneConfig = { ...DEFAULT_CONFIG, ...userConfig };
    
    // Validate configuration
    validateConfig(config);
    
    // Get user confirmation
    const confirmed = await getConfirmation(config);
    if (!confirmed) {
      logger.info('Operation cancelled by user');
      return;
    }
    
    logger.info('Starting transaction pruning operation', {
      beforeDate: config.beforeDate,
      afterDate: config.afterDate,
      fromDate: config.fromDate,
      toDate: config.toDate,
      keepCount: config.keepCount,
      batchSize: config.batchSize,
      concurrency: config.concurrency,
      dryRun: config.dryRun,
      enableGc: config.enableGc
    });
    
    // Initialize database connection
    const dataSource = await createDataSource(config.databaseUrl);
    
    try {
      let transactionsDeleted = 0;
      let logsDeleted = 0;
      const startTime = Date.now();
      
      if (config.keepCount !== undefined) {
        // Count-based pruning
        const totalTransactions = await getTotalTransactionCount(dataSource);
        
        if (totalTransactions <= config.keepCount) {
          logger.info(`No pruning needed. Database has ${totalTransactions} transactions, keeping ${config.keepCount}`);
          return;
        }
        
        logger.info(`Database has ${totalTransactions} transactions, will keep ${config.keepCount} latest`);
        
        // Get cutoff timestamp
        const cutoffTimestamp = await getCutoffTimestampForCount(dataSource, config.keepCount);
        
        if (!cutoffTimestamp) {
          logger.info('No cutoff timestamp found, no transactions to delete');
          return;
        }
        
        logger.info(`Cutoff timestamp: ${cutoffTimestamp.toISOString()}`);
        
        // Delete transactions older than cutoff
        const result = await deleteTransactionsOlderThanCutoff(dataSource, cutoffTimestamp, config);
        transactionsDeleted = result.transactionsDeleted;
        logsDeleted = result.logsDeleted;
        
        // Update daily stats for affected dates
        await updateDailyStatsAfterPruning(dataSource, cutoffTimestamp, null, config);
        
      } else {
        // Date-based pruning
        const { startDate, endDate } = getDateRange(config);
        
        // Count transactions to be deleted
        const transactionCount = await countTransactionsToDelete(dataSource, startDate, endDate);
        
        if (transactionCount === 0) {
          logger.info('No transactions found to delete');
          return;
        }
        
        logger.info(`Found ${transactionCount} transactions to delete`);
        
        // Delete transactions
        const result = await deleteTransactionsInBatches(dataSource, startDate, endDate, config);
        transactionsDeleted = result.transactionsDeleted;
        logsDeleted = result.logsDeleted;
        
        // Update daily stats
        await updateDailyStatsAfterPruning(dataSource, startDate, endDate, config);
      }
      
      const duration = Date.now() - startTime;
      
      logger.info('✅ Transaction pruning completed successfully', {
        transactionsDeleted,
        logsDeleted,
        totalDeleted: transactionsDeleted + logsDeleted,
        totalDuration: `${Math.round(duration / 1000)}s`,
        averagePerTransaction: transactionsDeleted > 0 ? `${Math.round(duration / transactionsDeleted)}ms` : 'N/A'
      });
      
    } finally {
      await dataSource.destroy();
      logger.info('Database connection closed');
    }
    
  } catch (error) {
    logger.error('❌ Transaction pruning failed', {
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