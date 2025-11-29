#!/usr/bin/env ts-node

import 'dotenv/config';
import { MonadClickHouseClient, ClickHouseConfig } from '../src/database/clickhouse-client';

interface ValidatorRegistryData {
  validator_id: string;
  node_id: string;
  epoch: number;
  stake: number;
  position: number;
  is_active: number;
  dns_address: string;
  dns_host: string;
  dns_port: number;
  provider: string;
  location: string;
  country: string;
  datacenter: string;
  first_seen: string;
  last_updated: string;
}

async function showValidatorRegistry() {
  console.log('🔍 Displaying Validator Registry Data...\n');
  
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

  try {
    // Test connection
    const isConnected = await client.ping();
    if (!isConnected) {
      console.error('❌ Database connection failed');
      return;
    }
    console.log('✅ Database connected successfully\n');

    // Check if validator_registry table exists
    const tablesQuery = `SHOW TABLES FROM ${config.database}`;
    const tables = await client.executeRawQuery(tablesQuery);
    const hasValidatorRegistry = tables.some((t: any) => t.name === 'validator_registry');

    if (!hasValidatorRegistry) {
      console.error('❌ validator_registry table does not exist');
      return;
    }

    // Get total count
    const countQuery = 'SELECT COUNT(*) as count FROM validator_registry';
    const countResult = await client.executeRawQuery(countQuery);
    const totalCount = countResult[0]?.count || 0;
    console.log(`📊 Total validator registry entries: ${totalCount}\n`);

    if (totalCount === 0) {
      console.log('ℹ️  No data found in validator_registry table');
      return;
    }

    // Get epoch distribution
    const epochQuery = `
      SELECT 
        epoch,
        COUNT(*) as validator_count,
        COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_count,
        SUM(stake) as total_stake,
        AVG(stake) as avg_stake,
        MIN(stake) as min_stake,
        MAX(stake) as max_stake
      FROM validator_registry 
      GROUP BY epoch 
      ORDER BY epoch DESC
    `;
    
    const epochResult = await client.executeRawQuery(epochQuery);
    console.log('📈 Validator Registry by Epoch:');
    epochResult.forEach((epoch: any) => {
      console.log(`  Epoch ${epoch.epoch}:`);
      console.log(`    Validators: ${epoch.validator_count} (${epoch.active_count} active)`);
      console.log(`    Total Stake: ${epoch.total_stake.toLocaleString()}`);
      console.log(`    Avg Stake: ${epoch.avg_stake.toFixed(2)}`);
      console.log(`    Stake Range: ${epoch.min_stake.toLocaleString()} - ${epoch.max_stake.toLocaleString()}`);
    });

    // Get geographic distribution
    const geoQuery = `
      SELECT 
        location,
        country,
        provider,
        COUNT(*) as validator_count,
        COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_count,
        SUM(stake) as total_stake
      FROM validator_registry 
      WHERE location != 'unknown' OR provider != 'unknown'
      GROUP BY location, country, provider
      ORDER BY validator_count DESC
      LIMIT 15
    `;
    
    const geoResult = await client.executeRawQuery(geoQuery);
    if (geoResult.length > 0) {
      console.log('\n🌍 Geographic Distribution:');
      geoResult.forEach((geo: any, i: number) => {
        console.log(`  ${i + 1}. ${geo.location || 'Unknown'}, ${geo.country || 'Unknown'} (${geo.provider || 'Unknown'})`);
        console.log(`     Validators: ${geo.validator_count} (${geo.active_count} active) | Stake: ${geo.total_stake.toLocaleString()}`);
      });
    }

    // Get recent entries (latest 10)
    const recentQuery = `
      SELECT 
        validator_id,
        node_id,
        epoch,
        stake,
        position,
        is_active,
        dns_address,
        dns_host,
        dns_port,
        provider,
        location,
        country,
        datacenter,
        first_seen,
        last_updated
      FROM validator_registry 
      ORDER BY last_updated DESC 
      LIMIT 10
    `;
    
    const recentResult = await client.executeRawQuery(recentQuery) as ValidatorRegistryData[];
    console.log('\n🔄 Recent Validator Registry Entries:');
    recentResult.forEach((validator, i) => {
      console.log(`\n  ${i + 1}. Validator ID: ${validator.validator_id.substring(0, 20)}...`);
      console.log(`     Node ID: ${validator.node_id.substring(0, 20)}...`);
      console.log(`     Epoch: ${validator.epoch} | Position: ${validator.position} | Active: ${validator.is_active ? 'Yes' : 'No'}`);
      console.log(`     Stake: ${validator.stake.toLocaleString()}`);
      if (validator.dns_address && validator.dns_address !== '') {
        console.log(`     DNS: ${validator.dns_address} (${validator.dns_host}:${validator.dns_port})`);
      }
      if (validator.location !== 'unknown' || validator.provider !== 'unknown') {
        console.log(`     Location: ${validator.location}, ${validator.country} | Provider: ${validator.provider}`);
      }
      if (validator.datacenter !== 'unknown') {
        console.log(`     Datacenter: ${validator.datacenter}`);
      }
      console.log(`     First Seen: ${validator.first_seen}`);
      console.log(`     Last Updated: ${validator.last_updated}`);
    });

    // Get top validators by stake
    const topStakeQuery = `
      SELECT 
        validator_id,
        node_id,
        epoch,
        stake,
        position,
        provider,
        location,
        is_active
      FROM validator_registry 
      WHERE is_active = 1
      ORDER BY stake DESC 
      LIMIT 10
    `;
    
    const topStakeResult = await client.executeRawQuery(topStakeQuery);
    console.log('\n🏆 Top Validators by Stake (Active Only):');
    topStakeResult.forEach((validator: any, i: number) => {
      console.log(`  ${i + 1}. ${validator.validator_id.substring(0, 16)}... | Stake: ${validator.stake.toLocaleString()} | Pos: ${validator.position}`);
      if (validator.location !== 'unknown') {
        console.log(`     Location: ${validator.location} (${validator.provider})`);
      }
    });

    // Provider distribution
    const providerQuery = `
      SELECT 
        provider,
        COUNT(*) as validator_count,
        COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_count,
        SUM(stake) as total_stake,
        AVG(stake) as avg_stake
      FROM validator_registry 
      WHERE provider != 'unknown'
      GROUP BY provider
      ORDER BY validator_count DESC
      LIMIT 10
    `;
    
    const providerResult = await client.executeRawQuery(providerQuery);
    if (providerResult.length > 0) {
      console.log('\n🏗️  Provider Distribution:');
      providerResult.forEach((provider: any, i: number) => {
        console.log(`  ${i + 1}. ${provider.provider}`);
        console.log(`     Validators: ${provider.validator_count} (${provider.active_count} active)`);
        console.log(`     Total Stake: ${provider.total_stake.toLocaleString()} | Avg: ${provider.avg_stake.toFixed(2)}`);
      });
    }

    // DNS mapping statistics
    const dnsQuery = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN dns_address != '' THEN 1 END) as with_dns,
        COUNT(CASE WHEN dns_host != '' THEN 1 END) as with_host,
        COUNT(CASE WHEN location != 'unknown' THEN 1 END) as with_location,
        COUNT(CASE WHEN provider != 'unknown' THEN 1 END) as with_provider
      FROM validator_registry
    `;
    
    const dnsResult = await client.executeRawQuery(dnsQuery);
    if (dnsResult.length > 0) {
      const stats = dnsResult[0];
      console.log('\n📊 Data Completeness Statistics:');
      console.log(`  Total entries: ${stats.total}`);
      console.log(`  With DNS address: ${stats.with_dns} (${((stats.with_dns / stats.total) * 100).toFixed(1)}%)`);
      console.log(`  With DNS host: ${stats.with_host} (${((stats.with_host / stats.total) * 100).toFixed(1)}%)`);
      console.log(`  With location: ${stats.with_location} (${((stats.with_location / stats.total) * 100).toFixed(1)}%)`);
      console.log(`  With provider: ${stats.with_provider} (${((stats.with_provider / stats.total) * 100).toFixed(1)}%)`);
    }

    console.log('\n✅ Validator registry data display completed!');

  } catch (error) {
    console.error('❌ Error displaying validator registry:', error);
  } finally {
    await client.close();
  }
}

// Handle command line options
async function main() {
  const args = process.argv.slice(2);
  
  // Check for help flag
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🔍 Validator Registry Display Tool

Usage: npm run show-validator-registry [options]

Options:
  --help, -h     Show this help message
  --epoch <num>  Show data for specific epoch only
  --active       Show only active validators
  --detailed     Show detailed information for each validator

Examples:
  npm run show-validator-registry
  npm run show-validator-registry --epoch 1
  npm run show-validator-registry --active
  npm run show-validator-registry --detailed --epoch 1
    `);
    return;
  }

  // Handle specific epoch filter
  const epochIndex = args.indexOf('--epoch');
  const specificEpoch = epochIndex !== -1 ? parseInt(args[epochIndex + 1]) : null;
  
  const activeOnly = args.includes('--active');
  const detailed = args.includes('--detailed');

  if (specificEpoch || activeOnly || detailed) {
    await showValidatorRegistryFiltered(specificEpoch, activeOnly, detailed);
  } else {
    await showValidatorRegistry();
  }
}

async function showValidatorRegistryFiltered(epoch: number | null, activeOnly: boolean, detailed: boolean) {
  console.log('🔍 Displaying Filtered Validator Registry Data...\n');
  
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

  try {
    const isConnected = await client.ping();
    if (!isConnected) {
      console.error('❌ Database connection failed');
      return;
    }

    // Build query with filters
    let whereClause = '';
    const conditions: string[] = [];
    
    if (epoch !== null) {
      conditions.push(`epoch = ${epoch}`);
    }
    
    if (activeOnly) {
      conditions.push('is_active = 1');
    }
    
    if (conditions.length > 0) {
      whereClause = `WHERE ${conditions.join(' AND ')}`;
    }

    const query = `
      SELECT 
        validator_id,
        node_id,
        epoch,
        stake,
        position,
        is_active,
        dns_address,
        dns_host,
        dns_port,
        provider,
        location,
        country,
        datacenter,
        first_seen,
        last_updated
      FROM validator_registry 
      ${whereClause}
      ORDER BY stake DESC
    `;
    
    const result = await client.executeRawQuery(query) as ValidatorRegistryData[];
    
    console.log(`📊 Found ${result.length} validators matching criteria:`);
    if (epoch !== null) console.log(`  Epoch: ${epoch}`);
    if (activeOnly) console.log(`  Active validators only`);
    console.log();

    if (detailed) {
      result.forEach((validator, i) => {
        console.log(`${i + 1}. Validator Details:`);
        console.log(`   Validator ID: ${validator.validator_id}`);
        console.log(`   Node ID: ${validator.node_id}`);
        console.log(`   Epoch: ${validator.epoch} | Position: ${validator.position}`);
        console.log(`   Stake: ${validator.stake.toLocaleString()} | Active: ${validator.is_active ? 'Yes' : 'No'}`);
        console.log(`   DNS: ${validator.dns_address || 'N/A'} (${validator.dns_host}:${validator.dns_port})`);
        console.log(`   Location: ${validator.location}, ${validator.country}`);
        console.log(`   Provider: ${validator.provider} | Datacenter: ${validator.datacenter}`);
        console.log(`   First Seen: ${validator.first_seen}`);
        console.log(`   Last Updated: ${validator.last_updated}`);
        console.log('');
      });
    } else {
      result.forEach((validator, i) => {
        console.log(`${i + 1}. ${validator.validator_id.substring(0, 20)}... | Stake: ${validator.stake.toLocaleString()} | Pos: ${validator.position} | ${validator.is_active ? 'Active' : 'Inactive'}`);
        if (validator.location !== 'unknown') {
          console.log(`   Location: ${validator.location} (${validator.provider})`);
        }
      });
    }

  } catch (error) {
    console.error('❌ Error displaying filtered validator registry:', error);
  } finally {
    await client.close();
  }
}

// Run the script
if (require.main === module) {
  main().catch(console.error);
}

export { showValidatorRegistry, showValidatorRegistryFiltered }; 