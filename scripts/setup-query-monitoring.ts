#!/usr/bin/env tsx

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import dotenv from 'dotenv';

dotenv.config();

async function setupQueryMonitoring(retryAttempts: number = 3): Promise<void> {
  console.log('🔧 Setting up query performance monitoring...');
  
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
    // Check if ClickHouse is responding
    if (!await client.ping()) {
      throw new Error('ClickHouse server is not responding');
    }
    console.log('✅ ClickHouse connection established');
    
    // First check if query_log table exists
    const checkQuery = `
      SELECT count() as table_exists 
      FROM system.tables 
      WHERE database = 'system' AND name = 'query_log'
    `;
    
    const rows = await client.executeRawQuery(checkQuery);
    const tableExists = rows[0]?.table_exists > 0;
    
    if (!tableExists) {
      console.log('❌ system.query_log table does not exist yet');
      console.log('   This is normal on first startup. The table will be created after some queries are executed.');
      console.log('   Run this script again after the system has been running for a few minutes.');
      return;
    }
    
    console.log('✅ system.query_log table exists, creating monitoring views...');
    
    // Define the monitoring views directly in code for better maintenance
    const monitoringViews = [
      {
        name: 'query_performance_monitor',
        sql: `
          CREATE VIEW IF NOT EXISTS query_performance_monitor AS
          SELECT 
            query_id,
            query_duration_ms,
            read_rows,
            read_bytes,
            formatReadableSize(read_bytes) as readable_bytes,
            result_rows,
            memory_usage,
            formatReadableSize(memory_usage) as readable_memory,
            substring(query, 1, 200) as query_snippet,
            event_time,
            type,
            exception,
            user,
            current_database
          FROM system.query_log
          WHERE event_time >= now() - INTERVAL 1 HOUR
            AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
            AND (current_database = 'monad_analytics' OR has(databases, 'monad_analytics'))
          ORDER BY query_duration_ms DESC
          LIMIT 100
        `
      },
      {
        name: 'slow_queries_monitor',
        sql: `
          CREATE VIEW IF NOT EXISTS slow_queries_monitor AS
          SELECT 
            query_id,
            query_duration_ms,
            formatReadableSize(memory_usage) as memory_used,
            substring(query, 1, 500) as query_text,
            event_time,
            user,
            exception
          FROM system.query_log
          WHERE event_time >= now() - INTERVAL 24 HOUR
            AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
            AND query_duration_ms > 1000
            AND (current_database = 'monad_analytics' OR has(databases, 'monad_analytics'))
          ORDER BY query_duration_ms DESC
          LIMIT 50
        `
      },
      {
        name: 'query_stats_hourly',
        sql: `
          CREATE VIEW IF NOT EXISTS query_stats_hourly AS
          SELECT 
            toStartOfHour(event_time) as hour,
            count() as total_queries,
            avg(query_duration_ms) as avg_duration_ms,
            max(query_duration_ms) as max_duration_ms,
            sum(read_rows) as total_read_rows,
            formatReadableSize(sum(read_bytes)) as total_read_bytes,
            formatReadableSize(sum(memory_usage)) as total_memory_usage,
            count(CASE WHEN exception != '' THEN 1 END) as failed_queries
          FROM system.query_log
          WHERE event_time >= now() - INTERVAL 7 DAY
            AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
            AND (current_database = 'monad_analytics' OR has(databases, 'monad_analytics'))
          GROUP BY hour
          ORDER BY hour DESC
        `
      }
    ];
    
    for (const view of monitoringViews) {
      try {
        await client.executeCommand(view.sql);
        console.log(`✅ Created view: ${view.name}`);
      } catch (error) {
        console.error(`❌ Failed to create view ${view.name}:`, error);
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
        const rows = await client.executeRawQuery(test.query);
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