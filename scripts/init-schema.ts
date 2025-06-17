#!/usr/bin/env ts-node

// Schema initialization script for Monad Analytics
import { readFileSync } from 'fs';
import { join } from 'path';
import { MonadClickHouseClient } from '../src/database/clickhouse-client';

async function initializeSchema() {
  console.log('🔄 Initializing Monad Analytics database schema...');

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

    // Initialize schema
    await client.initializeSchema();
    console.log('✅ Database schema initialized');

    // Load and execute materialized views
    console.log('🔄 Creating materialized views...');
    const materializedViewsSQL = readFileSync(
      join(__dirname, '../database/materialized-views.sql'), 
      'utf-8'
    );
    
    // Split by semicolon and execute each statement
    const statements = materializedViewsSQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      if (statement.includes('CREATE MATERIALIZED VIEW') || statement.includes('CREATE VIEW')) {
        try {
          await client['client'].command({ query: statement });
          const viewName = statement.match(/VIEW\s+(\w+)/i)?.[1];
          console.log(`  ✅ Created: ${viewName}`);
        } catch (error) {
          const viewName = statement.match(/VIEW\s+(\w+)/i)?.[1];
          console.log(`  ⚠️  ${viewName}: ${error}`);
        }
      }
    }

    // Verify tables were created
    console.log('🔍 Verifying table creation...');
    const tableStats = await client.getTableStats();
    console.log(`✅ Created ${tableStats.length} tables:`);
    
    for (const table of tableStats) {
      console.log(`  📊 ${table.table} (${table.engine})`);
    }

    console.log('🎉 Schema initialization completed successfully!');

  } catch (error) {
    console.error('❌ Schema initialization failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

// Run if called directly
if (require.main === module) {
  initializeSchema().catch(console.error);
} 