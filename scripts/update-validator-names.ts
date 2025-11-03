#!/usr/bin/env npx tsx

/**
 * Update Validator Names
 *
 * Updates the validator_registry table with validator information from GitHub registry.
 * This script:
 * 1. Loads all validators from the database
 * 2. Fetches validator info from monad-developers/validator-info GitHub repo
 * 3. Falls back to DNS hostname extraction for validators not in registry
 * 4. Updates validator_name and related fields (website, logo, description, x) in the database
 */

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { ValidatorInfoRegistry } from '../src/services/ValidatorInfoRegistry.js';

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
  const validatorInfoRegistry = new ValidatorInfoRegistry();

  try {
    console.log('🔌 Connecting to ClickHouse...');

    // Step 0: Load GitHub validator registry cache
    console.log('🌐 Loading validator info from GitHub registry...');
    await validatorInfoRegistry.forceRefresh();
    const cacheStats = validatorInfoRegistry.getCacheStats();
    console.log(`✅ Loaded ${cacheStats.size} validators from GitHub registry\n`);

    // Step 1: Get all validators from database
    console.log('📋 Loading validators from database...');
    const query = `
      SELECT
        validator_id,
        node_id,
        dns_address,
        dns_host,
        validator_name,
        validator_website,
        validator_logo_url,
        validator_description,
        validator_x_handle,
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
    
    // Step 3: Fetch validator info from GitHub registry and prepare updates
    console.log('\n🔧 Fetching validator info from GitHub registry...');
    const updates: Array<{
      validator_id: string,
      validator_name: string,
      validator_website: string,
      validator_logo_url: string,
      validator_description: string,
      validator_x_handle: string,
      hostname: string,
      source: 'github' | 'hostname'
    }> = [];

    for (const validator of validators) {
      // Get validator info from GitHub registry (with fallback to hostname extraction)
      const validatorInfo = await validatorInfoRegistry.getValidatorInfo(
        validator.node_id || validator.validator_id,
        validator.dns_host
      );

      // Determine the name and source
      let extractedName: string;
      let source: 'github' | 'hostname';
      let website = '';
      let logoUrl = '';
      let description = '';
      let xHandle = '';

      if (validatorInfo) {
        // Found in GitHub registry
        extractedName = validatorInfo.name;
        website = validatorInfo.website || '';
        logoUrl = validatorInfo.logo || '';
        description = validatorInfo.description || '';
        xHandle = validatorInfo.x || '';
        source = 'github';
      } else if (validator.dns_host) {
        // Fallback to hostname extraction
        extractedName = await validatorInfoRegistry.getValidatorName(
          validator.node_id || validator.validator_id,
          validator.dns_host
        );
        source = 'hostname';
      } else {
        continue;
      }

      const currentName = validator.validator_name;

      // Update if anything changed
      const needsUpdate = !currentName ||
        currentName === 'unknown' ||
        currentName !== extractedName ||
        validator.validator_website !== website ||
        validator.validator_logo_url !== logoUrl ||
        validator.validator_description !== description ||
        validator.validator_x_handle !== xHandle;

      if (needsUpdate) {
        updates.push({
          validator_id: validator.validator_id,
          validator_name: extractedName,
          validator_website: website,
          validator_logo_url: logoUrl,
          validator_description: description,
          validator_x_handle: xHandle,
          hostname: validator.dns_host || '',
          source
        });
      }
    }

    console.log(`✅ Found ${updates.length} validators needing updates`);
    const githubUpdates = updates.filter(u => u.source === 'github').length;
    const hostnameUpdates = updates.filter(u => u.source === 'hostname').length;
    console.log(`   From GitHub registry: ${githubUpdates}`);
    console.log(`   From hostname extraction: ${hostnameUpdates}`);
    
    if (updates.length === 0) {
      console.log('🎉 All validators already have correct names!');
      return;
    }
    
    // Step 4: Show sample of what will be updated
    console.log('\n📝 Sample of updates to be made:');
    console.log('VALIDATOR_ID'.padEnd(20) + 'NAME'.padEnd(30) + 'SOURCE'.padEnd(12) + 'WEBSITE');
    console.log('='.repeat(100));

    const sampleUpdates = updates.slice(0, 10);
    for (const update of sampleUpdates) {
      const validatorIdShort = update.validator_id.slice(0, 16) + '...';
      const websiteShort = update.validator_website ? update.validator_website.substring(0, 35) : '-';
      console.log(
        validatorIdShort.padEnd(20) +
        update.validator_name.padEnd(30) +
        update.source.padEnd(12) +
        websiteShort
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
           dns_address, dns_host, dns_port, validator_name, validator_website, validator_logo_url, validator_description, validator_x_handle,
           provider, location, country, datacenter, keybase_id, keybase_logo_url,
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
            '${escapeString(update.validator_website)}',
            '${escapeString(update.validator_logo_url)}',
            '${escapeString(update.validator_description)}',
            '${escapeString(update.validator_x_handle)}',
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
