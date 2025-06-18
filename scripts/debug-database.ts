import 'dotenv/config';
import { MonadClickHouseClient, ClickHouseConfig } from '../src/database/clickhouse-client';

async function debugDatabase() {
  console.log('🔍 Debug: Checking database content...');
  
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
    console.log('✅ Database connection:', isConnected);

    // Check if tables exist
    const tablesQuery = `SHOW TABLES FROM ${config.database}`;
    const tablesResult = await client['client'].query({
      query: tablesQuery,
      format: 'JSONEachRow'
    });
    const tables = await tablesResult.json() as any[];
    console.log('📊 Available tables:', tables.map(t => t.name));

    // Check validator_events table content
    if (tables.some(t => t.name === 'validator_events')) {
      const countQuery = 'SELECT COUNT(*) as count FROM validator_events';
      const countResult = await client['client'].query({
        query: countQuery,
        format: 'JSONEachRow'
      });
      const countData = await countResult.json() as any[];
      console.log('📈 Total events in validator_events:', countData[0]?.count || 0);

      // Check recent events
      const recentQuery = `
        SELECT 
          timestamp,
          event_type,
          validator_id,
          round_number,
          is_successful,
          metadata
        FROM validator_events 
        ORDER BY timestamp DESC 
        LIMIT 5
      `;
      
      const recentResult = await client['client'].query({
        query: recentQuery,
        format: 'JSONEachRow'
      });
      const recentData = await recentResult.json() as any[];
      console.log('🔄 Recent events:');
      recentData.forEach((event, i) => {
        console.log(`  ${i + 1}. ${event.timestamp} - ${event.event_type} - Validator: ${event.validator_id} - Round: ${event.round_number}`);
      });

      // Check event types distribution
      const eventTypesQuery = `
        SELECT 
          event_type,
          COUNT(*) as count
        FROM validator_events 
        GROUP BY event_type 
        ORDER BY count DESC
      `;
      
      const eventTypesResult = await client['client'].query({
        query: eventTypesQuery,
        format: 'JSONEachRow'
      });
      const eventTypesData = await eventTypesResult.json() as any[];
      console.log('📊 Event types distribution:');
      eventTypesData.forEach(et => {
        console.log(`  ${et.event_type}: ${et.count}`);
      });

      // Check validator distribution
      const validatorQuery = `
        SELECT 
          validator_id,
          COUNT(*) as count
        FROM validator_events 
        GROUP BY validator_id 
        ORDER BY count DESC
        LIMIT 10
      `;
      
      const validatorResult = await client['client'].query({
        query: validatorQuery,
        format: 'JSONEachRow'
      });
      const validatorData = await validatorResult.json() as any[];
      console.log('👤 Top validators by event count:');
      validatorData.forEach(v => {
        console.log(`  ${v.validator_id}: ${v.count} events`);
      });

      // Check for timestamps in last 24 hours
      const last24hQuery = `
        SELECT COUNT(*) as count 
        FROM validator_events 
        WHERE timestamp >= now() - INTERVAL 24 HOUR
      `;
      
      const last24hResult = await client['client'].query({
        query: last24hQuery,
        format: 'JSONEachRow'
      });
      const last24hData = await last24hResult.json() as any[];
      console.log('⏰ Events in last 24 hours:', last24hData[0]?.count || 0);

    } else {
      console.log('❌ validator_events table does not exist');
    }

    // Check raw_logs table if it exists
    if (tables.some(t => t.name === 'raw_logs')) {
      const rawLogsCountQuery = 'SELECT COUNT(*) as count FROM raw_logs';
      const rawLogsCountResult = await client['client'].query({
        query: rawLogsCountQuery,
        format: 'JSONEachRow'
      });
      const rawLogsCountData = await rawLogsCountResult.json() as any[];
      console.log('📝 Total raw logs:', rawLogsCountData[0]?.count || 0);
    }

  } catch (error) {
    console.error('❌ Error debugging database:', error);
  } finally {
    await client.close();
  }
}

debugDatabase().catch(console.error); 