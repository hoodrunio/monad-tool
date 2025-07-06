#!/usr/bin/env ts-node

// Migration script to add Keybase columns to validator_registry table
import { MonadClickHouseClient } from '../src/database/clickhouse-client';

async function addKeybaseColumns() {
  console.log('🔄 Adding Keybase columns to validator_registry table...');

  const config = {
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    max_open_connections: 5,
    max_query_timeout: 30000,
    compression: true
  };

  const client = new MonadClickHouseClient(config);

  try {
    // Test connection first
    console.log('📡 Testing ClickHouse connection...');
    const isConnected = await client.ping();
    if (!isConnected) {
      throw new Error('Cannot connect to ClickHouse. Is it running?');
    }
    console.log('✅ ClickHouse connection successful');

    // Check if columns already exist
    console.log('🔍 Checking existing columns...');
    const checkQuery = `
      SELECT name, type
      FROM system.columns
      WHERE database = 'monad_analytics' 
        AND table = 'validator_registry'
        AND name IN ('keybase_id', 'keybase_logo_url')
    `;

    const existingColumns = await client.executeRawQuery(checkQuery);
    const existingColumnNames = existingColumns.map(col => col.name);

    console.log(`Found existing columns: ${existingColumnNames.join(', ')}`);

    // Add keybase_id column if it doesn't exist
    if (!existingColumnNames.includes('keybase_id')) {
      console.log('➕ Adding keybase_id column...');
      await client.executeCommand(`
        ALTER TABLE validator_registry 
        ADD COLUMN keybase_id LowCardinality(String) DEFAULT ''
      `);
      console.log('✅ keybase_id column added');
    } else {
      console.log('ℹ️  keybase_id column already exists');
    }

    // Add keybase_logo_url column if it doesn't exist
    if (!existingColumnNames.includes('keybase_logo_url')) {
      console.log('➕ Adding keybase_logo_url column...');
      await client.executeCommand(`
        ALTER TABLE validator_registry 
        ADD COLUMN keybase_logo_url String DEFAULT ''
      `);
      console.log('✅ keybase_logo_url column added');
    } else {
      console.log('ℹ️  keybase_logo_url column already exists');
    }

    // Verify the columns were added
    console.log('🔍 Verifying column addition...');
    const verifyQuery = `
      SELECT name, type, default_expression
      FROM system.columns
      WHERE database = 'monad_analytics' 
        AND table = 'validator_registry'
        AND name IN ('keybase_id', 'keybase_logo_url')
      ORDER BY name
    `;

    const finalColumns = await client.executeRawQuery(verifyQuery);
    
    console.log('✅ Final column status:');
    for (const col of finalColumns) {
      console.log(`  📊 ${col.name}: ${col.type} (default: ${col.default_expression})`);
    }

    console.log('🎉 Keybase columns migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

// Run if called directly
if (require.main === module) {
  addKeybaseColumns().catch(console.error);
} 