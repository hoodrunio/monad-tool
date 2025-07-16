/**
 * Test script to verify the new smart validator registry sync
 * 
 * This script tests the improved updateValidatorRegistry method that only
 * creates new entries when validator metadata has actually changed.
 */

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { ValidatorService } from '../src/services/unified-validator';
import { ServiceContainer } from '../src/services/service-container';
import { NodeRpcClient } from '../src/services/blockchain/NodeRpcClient';
import { EpochService } from '../src/services/epoch/EpochService';

interface TestResults {
  validatorId: string;
  beforeCount: number;
  afterCount: number;
  actuallyUpdated: boolean;
  latestEpochs: number[];
}

// Test configuration
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

async function testSmartValidatorSync(): Promise<void> {
  console.log('🧪 Testing Smart Validator Registry Sync');
  console.log('=' .repeat(50));

  const serviceContainer = ServiceContainer.getInstance(config);
  await serviceContainer.initialize();
  const clickhouseClient = serviceContainer.getClickHouseClient();
  
  try {
    // Step 1: Check current state for a sample of validators
    console.log('📊 Checking current state...');
    const sampleValidatorsQuery = `
      SELECT validator_id, COUNT(*) as entry_count, groupArray(epoch) as epochs
      FROM validator_registry 
      GROUP BY validator_id 
      ORDER BY entry_count DESC 
      LIMIT 5
    `;
    
    const beforeState = await clickhouseClient.executeRawQuery(sampleValidatorsQuery);
    console.log('📋 Sample validators before sync:');
    beforeState.forEach(row => {
      console.log(`  ${row.validator_id.substring(0, 16)}... : ${row.entry_count} entries, epochs: [${row.epochs.slice(-3).join(', ')}]`);
    });

    // Step 2: Get current system state
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error('RPC_URL environment variable is not set.');
    }
    
    const rpcClient = new NodeRpcClient(rpcUrl);
    const epochService = new EpochService(rpcClient);
    const validatorService = serviceContainer.getValidatorService();
    
    // Get current epoch and validators
    const currentEpoch = await epochService.getCurrentEpoch();
    validatorService.setCurrentEpoch(currentEpoch);
    console.log(`\n🕐 Current epoch: ${currentEpoch}`);
    
    const validators = await validatorService.getAllValidators(currentEpoch);
    console.log(`👥 Retrieved ${validators.length} validators for sync`);

    // Step 3: Run the smart sync
    console.log('\n🚀 Running smart validator registry sync...');
    const syncStartTime = Date.now();
    
    await clickhouseClient.updateValidatorRegistry(validators);
    
    const syncDuration = Date.now() - syncStartTime;
    console.log(`⏱️  Sync completed in ${syncDuration}ms`);

    // Step 4: Check state after sync
    console.log('\n📊 Checking state after sync...');
    const afterState = await clickhouseClient.executeRawQuery(sampleValidatorsQuery);
    
    // Step 5: Analyze results
    console.log('\n📈 Results Analysis:');
    console.log('=' .repeat(50));
    
    const results: TestResults[] = [];
    let totalUpdated = 0;
    let totalSkipped = 0;
    
    for (const beforeRow of beforeState) {
      const afterRow = afterState.find(row => row.validator_id === beforeRow.validator_id);
      const actuallyUpdated = afterRow ? afterRow.entry_count > beforeRow.entry_count : false;
      
      if (actuallyUpdated) totalUpdated++;
      else totalSkipped++;
      
      results.push({
        validatorId: beforeRow.validator_id,
        beforeCount: beforeRow.entry_count,
        afterCount: afterRow?.entry_count || beforeRow.entry_count,
        actuallyUpdated,
        latestEpochs: afterRow?.epochs.slice(-3) || beforeRow.epochs.slice(-3)
      });
      
      const status = actuallyUpdated ? '🔄 UPDATED' : '✅ SKIPPED';
      const change = actuallyUpdated ? `+${afterRow!.entry_count - beforeRow.entry_count}` : 'no change';
      console.log(`  ${status} ${beforeRow.validator_id.substring(0, 16)}... : ${beforeRow.entry_count} → ${afterRow?.entry_count || beforeRow.entry_count} (${change})`);
    }

    // Step 6: Summary statistics
    console.log('\n📊 Summary:');
    console.log(`  Total validators in sample: ${results.length}`);
    console.log(`  Actually updated: ${totalUpdated}`);
    console.log(`  Skipped (unchanged): ${totalSkipped}`);
    console.log(`  Skip rate: ${((totalSkipped / results.length) * 100).toFixed(1)}%`);

    // Step 7: Test specific validator detail
    if (results.length > 0) {
      const testValidatorId = results[0].validatorId;
      console.log(`\n🔍 Detailed analysis for ${testValidatorId.substring(0, 16)}...:`);
      
      const detailQuery = `
        SELECT epoch, last_updated, validator_name, provider, location
        FROM validator_registry 
        WHERE validator_id = '${testValidatorId}'
        ORDER BY last_updated DESC
        LIMIT 3
      `;
      
      const detailResults = await clickhouseClient.executeRawQuery(detailQuery);
      detailResults.forEach((row, index) => {
        console.log(`  ${index + 1}. Epoch ${row.epoch}: ${row.last_updated} - ${row.validator_name} @ ${row.provider}`);
      });
    }

    // Step 8: Verify no excessive duplication
    console.log('\n🔍 Checking for excessive duplication...');
    const duplicationQuery = `
      SELECT 
        COUNT(*) as validators_with_excess_entries,
        AVG(entry_count) as avg_entries_per_validator,
        MAX(entry_count) as max_entries_per_validator
      FROM (
        SELECT validator_id, COUNT(*) as entry_count
        FROM validator_registry 
        GROUP BY validator_id
        HAVING entry_count > 10
      )
    `;
    
    const duplicationResults = await clickhouseClient.executeRawQuery(duplicationQuery);
    if (duplicationResults.length > 0 && duplicationResults[0].validators_with_excess_entries > 0) {
      console.log(`  ⚠️  Found ${duplicationResults[0].validators_with_excess_entries} validators with >10 entries`);
      console.log(`  📊 Average entries: ${duplicationResults[0].avg_entries_per_validator.toFixed(1)}`);
      console.log(`  📊 Max entries: ${duplicationResults[0].max_entries_per_validator}`);
    } else {
      console.log('  ✅ No excessive duplication detected');
    }

    console.log('\n✅ Smart validator sync test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

// Run the test
if (require.main === module) {
  testSmartValidatorSync()
    .then(() => {
      console.log('\n🎉 Test completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Test failed:', error);
      process.exit(1);
    });
}

export { testSmartValidatorSync }; 