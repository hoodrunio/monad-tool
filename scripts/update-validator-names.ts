#!/usr/bin/env npx tsx

/**
 * Update Validator Names
 * 
 * Updates the validator_registry table with extracted validator names from DNS hostnames.
 * This script:
 * 1. Loads all validators from the database
 * 2. Extracts validator names from their DNS hostnames
 * 3. Updates the validator_name field in the database
 */

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { DomainExtractor } from '../src/services/dns/DomainExtractor';

async function updateValidatorNames() {
  console.log('🏷️  Updating Validator Names in Database\n');
  
  const config = {
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    max_open_connections: 10,
    max_query_timeout: 30000,
    compression: true
  };
  
  const clickhouseClient = new MonadClickHouseClient(config);
  const domainExtractor = new DomainExtractor();
  
  try {
    console.log('🔌 Connecting to ClickHouse...');
    
    // Step 1: Get all validators from database
    console.log('📋 Loading validators from database...');
    const query = `
      SELECT 
        validator_id,
        dns_address,
        dns_host,
        validator_name,
        last_updated
      FROM validator_registry 
      WHERE is_active = 1
      ORDER BY validator_id
    `;
    
    const validators = await clickhouseClient.executeRawQuery(query);
    console.log(`✅ Loaded ${validators.length} validators from database`);
    
    if (validators.length === 0) {
      console.log('❌ No validators found in database. Run database initialization first.');
      return;
    }
    
    // Step 2: Analyze current state
    console.log('\n📊 Current Validator Name State:');
    let validatorsWithNames = 0;
    let validatorsNeedingUpdate = 0;
    
    for (const validator of validators) {
      const currentName = validator.validator_name;
      if (currentName && currentName !== 'unknown') {
        validatorsWithNames++;
      } else if (validator.dns_host) {
        validatorsNeedingUpdate++;
      }
    }
    
    console.log(`   Total validators: ${validators.length}`);
    console.log(`   With names: ${validatorsWithNames}`);
    console.log(`   Needing update: ${validatorsNeedingUpdate}`);
    console.log(`   Current completion: ${((validatorsWithNames / validators.length) * 100).toFixed(1)}%`);
    
    // Step 3: Extract validator names and prepare updates
    console.log('\n🔧 Extracting validator names...');
    const updates: Array<{validator_id: string, validator_name: string, hostname: string}> = [];
    
    for (const validator of validators) {
      if (!validator.dns_host) continue;
      
      const extractedName = domainExtractor.extractValidatorName(validator.dns_host);
      const currentName = validator.validator_name;
      
      // Update if name is missing or different
      if (!currentName || currentName === 'unknown' || currentName !== extractedName) {
        updates.push({
          validator_id: validator.validator_id,
          validator_name: extractedName,
          hostname: validator.dns_host
        });
      }
    }
    
    console.log(`✅ Found ${updates.length} validators needing name updates`);
    
    if (updates.length === 0) {
      console.log('🎉 All validators already have correct names!');
      return;
    }
    
    // Step 4: Show sample of what will be updated
    console.log('\n📝 Sample of updates to be made:');
    console.log('VALIDATOR_ID'.padEnd(20) + 'HOSTNAME'.padEnd(40) + 'EXTRACTED_NAME');
    console.log('='.repeat(80));
    
    const sampleUpdates = updates.slice(0, 10);
    for (const update of sampleUpdates) {
      const validatorIdShort = update.validator_id.slice(0, 16) + '...';
      console.log(
        validatorIdShort.padEnd(20) + 
        update.hostname.padEnd(40) + 
        update.validator_name
      );
    }
    
    if (updates.length > 10) {
      console.log(`... and ${updates.length - 10} more`);
    }
    
    // Step 5: Confirm before proceeding
    console.log(`\n❓ Proceed with updating ${updates.length} validators? (This will modify the database)`);
    console.log('Press Ctrl+C to cancel, or any key to continue...');
    
    // Wait for user input (in a real scenario, you might want to add proper prompting)
    await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
    
    // Step 6: Perform batch updates
    console.log('\n🚀 Updating validator names in database...');
    
    const batchSize = 50;
    let updateCount = 0;
    
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      
      console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(updates.length / batchSize)} (${batch.length} validators)...`);

      for (const update of batch) {
        const nowTs = formatTimestamp(new Date());
        const updateQuery = `
          INSERT INTO validator_registry 
          (validator_id, node_id, precompile_validator_id, epoch, stake, position, is_active, is_staking_active, real_time_stake_wei,
           dns_address, dns_host, dns_port, validator_name, provider, location, country, datacenter, keybase_id, keybase_logo_url,
           first_seen, last_updated)
          SELECT 
            validator_id,
            node_id,
            precompile_validator_id,
            epoch,
            stake,
            position,
            is_active,
            is_staking_active,
            real_time_stake_wei,
            dns_address,
            dns_host,
            dns_port,
            '${escapeString(update.validator_name)}',
            provider,
            location,
            country,
            datacenter,
            keybase_id,
            keybase_logo_url,
            first_seen,
            '${nowTs}'
          FROM validator_registry
          WHERE validator_id = '${escapeString(update.validator_id)}'
          ORDER BY last_updated DESC
          LIMIT 1
        `;

        try {
          await clickhouseClient.executeCommand(updateQuery);
          updateCount++;
        } catch (error) {
          console.error(`   ❌ Failed to update validator ${update.validator_id}:`, error);
          throw error;
        }
      }

      console.log(`   ✅ Updated ${batch.length} validators`);
    }
    
    console.log(`\n✅ Successfully updated ${updateCount} validators with validator names`);
    
    // Step 7: Verify results
    console.log('\n🔍 Verifying results...');
    const verificationQuery = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN validator_name != 'unknown' AND validator_name != '' THEN 1 ELSE 0 END) as with_names
      FROM validator_registry 
      WHERE is_active = 1
    `;
    
    const results = await clickhouseClient.executeRawQuery(verificationQuery);
    if (results.length > 0) {
      const { total, with_names } = results[0];
      const completionRate = (with_names / total) * 100;
      
      console.log('📊 Final Results:');
      console.log(`   Total validators: ${total}`);
      console.log(`   With names: ${with_names}`);
      console.log(`   Completion rate: ${completionRate.toFixed(1)}%`);
      
      if (completionRate > 95) {
        console.log('🎉 Excellent! Almost all validators have names.');
      } else if (completionRate > 80) {
        console.log('✅ Good completion rate.');
      } else {
        console.log('⚠️  Consider investigating validators without names.');
      }
    }
    
  } catch (error) {
    console.error('❌ Failed to update validator names:', error);
  }
}

/**
 * Escape string values for SQL
 */
function escapeString(value: string): string {
  if (!value) return '';
  return value
    .replace(/'/g, "''")
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Format Date to ClickHouse DateTime64 format
 */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

// Run the update
updateValidatorNames().catch(console.error); 
