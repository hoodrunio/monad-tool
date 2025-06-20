import { MonadClickHouseClient } from '../src/database/clickhouse-client';

async function checkLocationData() {
  const client = new MonadClickHouseClient({
    host: 'localhost',
    port: 8123,
    username: 'default',
    password: '',
    database: 'monad_analytics',
    max_open_connections: 10,
    max_query_timeout: 30000,
    compression: false
  });

  try {
    console.log('🔍 Checking location data...\n');

    // Check location data in block_proposals
    const locationQuery = `
      SELECT DISTINCT location, COUNT(*) as count 
      FROM block_proposals 
      WHERE location IS NOT NULL AND location != '' AND location != 'unknown'
      GROUP BY location 
      ORDER BY count DESC 
      LIMIT 10
    `;
    
    const locationResult = await client.executeRawQuery(locationQuery);
    console.log('📍 Location data in block_proposals:');
    console.log(locationResult);

    // Check overall statistics
    const statsQuery = `
      SELECT 
        COUNT(DISTINCT location) as unique_locations,
        COUNT(*) as total_records,
        COUNT(CASE WHEN location IS NULL OR location = '' OR location = 'unknown' THEN 1 END) as missing_location,
        COUNT(CASE WHEN location IS NOT NULL AND location != '' AND location != 'unknown' THEN 1 END) as with_location
      FROM block_proposals
      WHERE timestamp >= now() - INTERVAL 24 HOUR
    `;
    
    const statsResult = await client.executeRawQuery(statsQuery);
    console.log('\n📊 Location statistics:');
    console.log(statsResult);

    // Check a few sample records
    const sampleQuery = `
      SELECT validator_id, location, provider, timestamp
      FROM block_proposals 
      WHERE timestamp >= now() - INTERVAL 24 HOUR
      ORDER BY timestamp DESC 
      LIMIT 5
    `;
    
    const sampleResult = await client.executeRawQuery(sampleQuery);
    console.log('\n📋 Sample records:');
    console.log(sampleResult);

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkLocationData().then(() => {
  console.log('\n✅ Location data check complete');
  process.exit(0);
}).catch(error => {
  console.error('❌ Script failed:', error);
  process.exit(1);
}); 