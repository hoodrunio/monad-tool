#!/usr/bin/env tsx

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import dotenv from 'dotenv';

dotenv.config();

async function setupQueryMonitoring(): Promise<void> {
  console.log('Setting up query performance monitoring...');
  
  const config = {
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    max_open_connections: parseInt(process.env.CLICKHOUSE_MAX_OPEN_CONNECTIONS || '10'),
    max_query_timeout: parseInt(process.env.CLICKHOUSE_MAX_QUERY_TIMEOUT || '30000'),
    compression: process.env.CLICKHOUSE_COMPRESSION === 'true'
  };
  
  const client = new MonadClickHouseClient(config);
  
  try {
    // First check if query_log table exists
    const checkQuery = `
      SELECT count() as table_exists 
      FROM system.tables 
      WHERE database = 'system' AND name = 'query_log'
    `;
    
    const result = await (client as any).client.query({
      query: checkQuery,
      format: 'JSONEachRow'
    });
    const rows = await result.json() as any[];
    const tableExists = rows[0]?.table_exists > 0;
    
    if (!tableExists) {
      console.log('❌ system.query_log table does not exist yet');
      console.log('   This is normal on first startup. The table will be created after some queries are executed.');
      console.log('   Run this script again after the system has been running for a few minutes.');
      return;
    }
    
    console.log('✅ system.query_log table exists, creating monitoring views...');
    
    // Read the SQL file and execute it
    const fs = await import('fs');
    const path = await import('path');
    
    const sqlFilePath = path.join(__dirname, 'create-query-performance-view.sql');
    const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');
    
    // Split by semicolon and execute each statement
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));
    
    for (const statement of statements) {
      try {
        await (client as any).client.command({ query: statement });
        console.log('✅ Executed query monitoring statement');
      } catch (error) {
        console.error('❌ Failed to execute statement:', error);
        console.log('Statement was:', statement.substring(0, 100) + '...');
      }
    }
    
    // Test the views
    console.log('\n🧪 Testing query performance views...');
    
    const testQueries = [
      { name: 'query_performance_monitor', query: 'SELECT count() FROM query_performance_monitor' },
      { name: 'slow_queries_monitor', query: 'SELECT count() FROM slow_queries_monitor' },
      { name: 'query_stats_hourly', query: 'SELECT count() FROM query_stats_hourly' }
    ];
    
    for (const test of testQueries) {
      try {
        const result = await (client as any).client.query({
          query: test.query,
          format: 'JSONEachRow'
        });
        const rows = await result.json() as any[];
        console.log(`✅ View ${test.name}: ${rows[0]?.['count()'] || 0} records`);
      } catch (error) {
        console.error(`❌ View ${test.name} failed:`, error);
      }
    }
    
    console.log('\n🎉 Query monitoring setup complete!');
    console.log('\nAvailable views:');
    console.log('  - query_performance_monitor: Recent query performance metrics');
    console.log('  - slow_queries_monitor: Queries taking longer than 1 second');
    console.log('  - query_stats_hourly: Hourly aggregated query statistics');
    
  } catch (error) {
    console.error('❌ Failed to setup query monitoring:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  setupQueryMonitoring().catch(console.error);
}

export { setupQueryMonitoring }; 