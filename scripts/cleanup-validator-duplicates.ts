/**
 * Cleanup Validator Registry Duplicates
 * 
 * This script removes unnecessary duplicate entries from validator_registry table.
 * It keeps only the latest record for each validator (highest last_updated timestamp)
 * and removes older entries that are no longer needed.
 */

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { ServiceContainer } from '../src/services/service-container';

// Configuration
const config = {
  clickhouse: {
    host: 'localhost',
    port: 8123,
    username: 'default',
    password: '',
    database: 'monad_analytics',
    max_open_connections: 10,
    max_query_timeout: 30000,
    compression: true,
  },
  redis: {
    host: 'localhost',
    port: 6379,
    password: '',
    db: 0,
    keyPrefix: 'monad:',
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    enableOfflineQueue: false,
    maxMemoryPolicy: 'allkeys-lru' as const,
    defaultTtl: 300,
  }
};

interface DuplicateStats {
  validatorId: string;
  totalEntries: number;
  epochs: number[];
  updateTimes: string[];
}

async function cleanupValidatorDuplicates(): Promise<void> {
  console.log('🧹 Cleaning up Validator Registry Duplicates');
  console.log('=' .repeat(50));

  const serviceContainer = ServiceContainer.getInstance(config);
  await serviceContainer.initialize();
  const clickhouseClient = serviceContainer.getClickHouseClient();

  try {
    // Step 1: Analyze current duplication state
    console.log('📊 Analyzing current duplication state...');
    const duplicateAnalysisQuery = `
      SELECT 
        validator_id,
        COUNT(*) as entry_count,
        groupArray(epoch) as epochs,
        groupArray(last_updated) as update_times
      FROM validator_registry 
      GROUP BY validator_id 
      HAVING entry_count > 1
      ORDER BY entry_count DESC
    `;
    
    const duplicates = await clickhouseClient.executeRawQuery(duplicateAnalysisQuery) as DuplicateStats[];
    
    console.log(`🔍 Found ${duplicates.length} validators with duplicate entries`);
    if (duplicates.length === 0) {
      console.log('✅ No duplicates found - cleanup not needed');
      return;
    }

    // Show top duplicates
    console.log('\n📋 Top validators with most duplicates:');
    duplicates.slice(0, 5).forEach(dup => {
      console.log(`  ${dup.validatorId.substring(0, 16)}... : ${dup.totalEntries} entries, epochs: [${dup.epochs.slice(-3).join(', ')}]`);
    });

    // Step 2: Calculate cleanup impact
    const totalDuplicateEntries = duplicates.reduce((sum, dup) => sum + (dup.totalEntries - 1), 0);
    console.log(`\n💾 Cleanup impact: ${totalDuplicateEntries} duplicate entries will be removed`);

    // Step 3: Create cleanup strategy
    console.log('\n🎯 Creating cleanup strategy...');
    console.log('Strategy: Keep latest record for each validator (highest last_updated), remove others');

    // Ask for confirmation
    console.log('\n⚠️  WARNING: This operation will permanently delete duplicate records!');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 4: Execute cleanup in batches
    console.log('\n🚀 Starting cleanup process...');
    let totalCleaned = 0;
    const batchSize = 10;

    for (let i = 0; i < duplicates.length; i += batchSize) {
      const batch = duplicates.slice(i, i + batchSize);
      console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(duplicates.length / batchSize)} (${batch.length} validators)...`);

      for (const duplicate of batch) {
        const cleaned = await cleanupValidatorDuplicate(clickhouseClient, duplicate.validatorId);
        totalCleaned += cleaned;
      }

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Step 5: Optimize table to finalize cleanup
    console.log('\n🔧 Optimizing table to finalize cleanup...');
    await clickhouseClient.executeCommand('OPTIMIZE TABLE validator_registry FINAL');

    // Step 6: Verify cleanup results
    console.log('\n🔍 Verifying cleanup results...');
    const afterCleanup = await clickhouseClient.executeRawQuery(duplicateAnalysisQuery);
    
    console.log('\n📊 Cleanup Results:');
    console.log(`  Before: ${duplicates.length} validators with duplicates`);
    console.log(`  After: ${afterCleanup.length} validators with duplicates`);
    console.log(`  Removed: ${totalCleaned} duplicate entries`);
    console.log(`  Success rate: ${(((duplicates.length - afterCleanup.length) / duplicates.length) * 100).toFixed(1)}%`);

    if (afterCleanup.length === 0) {
      console.log('🎉 Perfect! All duplicates have been cleaned up successfully!');
    } else {
      console.log(`⚠️  ${afterCleanup.length} validators still have duplicates - may need manual investigation`);
    }

    console.log('\n✅ Validator duplicate cleanup completed!');

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    throw error;
  }
}

/**
 * Clean up duplicates for a specific validator
 * Keeps the latest record and removes older ones
 */
async function cleanupValidatorDuplicate(clickhouseClient: MonadClickHouseClient, validatorId: string): Promise<number> {
  try {
    // Get all records for this validator, ordered by last_updated DESC
    const getAllRecordsQuery = `
      SELECT *
      FROM validator_registry 
      WHERE validator_id = '${validatorId}'
      ORDER BY last_updated DESC
    `;
    
    const allRecords = await clickhouseClient.executeRawQuery(getAllRecordsQuery);
    
    if (allRecords.length <= 1) {
      return 0; // No duplicates to clean
    }

    // Keep the first record (latest), prepare to delete others
    const latestRecord = allRecords[0];
    const recordsToDelete = allRecords.slice(1);

    console.log(`    🗑️  Cleaning ${validatorId.substring(0, 16)}... : keeping epoch ${latestRecord.epoch}, removing ${recordsToDelete.length} older entries`);

    // Delete older records one by one (since ClickHouse doesn't support complex DELETE conditions easily)
    for (const record of recordsToDelete) {
      const deleteQuery = `
        ALTER TABLE validator_registry 
        DELETE WHERE validator_id = '${validatorId}' 
        AND epoch = ${record.epoch} 
        AND last_updated = '${record.last_updated}'
      `;
      
      await clickhouseClient.executeCommand(deleteQuery);
    }

    return recordsToDelete.length;

  } catch (error) {
    console.error(`    ❌ Failed to cleanup ${validatorId}:`, error);
    return 0;
  }
}

// Run the cleanup
if (require.main === module) {
  cleanupValidatorDuplicates()
    .then(() => {
      console.log('\n🎉 Cleanup completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Cleanup failed:', error);
      process.exit(1);
    });
}

export { cleanupValidatorDuplicates }; 