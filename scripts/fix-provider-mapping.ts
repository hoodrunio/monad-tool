#!/usr/bin/env ts-node

import 'dotenv/config';
import { MonadClickHouseClient, ClickHouseConfig } from '../src/database/clickhouse-client';
import { DatabaseValidatorInitializer } from '../src/services/database-validator-initializer';

async function fixProviderMapping() {
  console.log('🔧 Fixing Provider Mapping - Force Re-initialization...\n');

  const config: ClickHouseConfig = {
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    max_open_connections: 10,
    max_query_timeout: 30000,
    compression: process.env.CLICKHOUSE_COMPRESSION === 'true'
  };

  const client = new MonadClickHouseClient(config);
  const dbInitializer = new DatabaseValidatorInitializer(client);

  try {
    const isConnected = await client.ping();
    if (!isConnected) {
      console.error('❌ Database connection failed');
      return;
    }

    // Step 1: Check current database state
    console.log('📊 Step 1: Analyzing current database state...');
    const currentStats = await dbInitializer.getDatabaseValidatorStats();
    console.log(`📈 Current stats:`);
    console.log(`   Total validators: ${currentStats.totalValidators}`);
    console.log(`   Location completion: ${currentStats.completionRate.toFixed(1)}%`);
    console.log(`   Provider completion: ${currentStats.providerCompletionRate.toFixed(1)}% (${currentStats.validatorsWithProvider}/${currentStats.totalValidators})`);

    // Step 2: Clear the validator registry to force re-initialization
    console.log('\n🗑️  Step 2: Clearing validator registry to force re-initialization...');
    await client.executeCommand('TRUNCATE TABLE validator_registry');
    console.log('✅ Validator registry cleared');

    // Step 3: Force re-initialization
    console.log('\n🔄 Step 3: Starting forced re-initialization with fixed logic...');
    await dbInitializer.ensureValidatorsInDatabase();

    // Step 4: Verify the fix
    console.log('\n📊 Step 4: Verifying the fix...');
    const finalStats = await dbInitializer.getDatabaseValidatorStats();
    console.log(`📈 Final stats:`);
    console.log(`   Total validators: ${finalStats.totalValidators}`);
    console.log(`   Location completion: ${finalStats.completionRate.toFixed(1)}%`);
    console.log(`   Provider completion: ${finalStats.providerCompletionRate.toFixed(1)}% (${finalStats.validatorsWithProvider}/${finalStats.totalValidators})`);

    // Step 5: Show sample results
    console.log('\n🔍 Step 5: Sample provider mappings...');
    const sampleQuery = `
      SELECT 
        validator_id,
        dns_host,
        provider,
        location,
        country
      FROM validator_registry 
      WHERE provider != 'unknown'
      ORDER BY position
      LIMIT 10
    `;
    
    const sampleResults = await client.executeRawQuery(sampleQuery);
    console.log(`✅ Found ${sampleResults.length} validators with proper provider data:`);
    sampleResults.forEach((validator: any, i: number) => {
      console.log(`  ${i + 1}. ${validator.dns_host} → ${validator.provider} (${validator.location})`);
    });

    // Check if any validators still have unknown provider
    const unknownQuery = `
      SELECT COUNT(*) as count
      FROM validator_registry 
      WHERE provider = 'unknown'
    `;
    
    const unknownResults = await client.executeRawQuery(unknownQuery);
    const unknownCount = unknownResults[0]?.count || 0;
    
    if (unknownCount === 0) {
      console.log('\n🎉 SUCCESS: All validators now have proper provider data!');
    } else {
      console.log(`\n⚠️  ${unknownCount} validators still have unknown provider data`);
    }

    await client.close();

  } catch (error) {
    console.error('❌ Error fixing provider mapping:', error);
  }
}

// Run the fix
if (require.main === module) {
  fixProviderMapping().catch(console.error);
}

export { fixProviderMapping };

