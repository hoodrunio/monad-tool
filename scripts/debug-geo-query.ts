import { MonadClickHouseClient } from '../src/database/clickhouse-client';

async function debugGeoQuery() {
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
    console.log('🔍 Debugging geographic distribution query...\n');

    // Test the location_data CTE first
    console.log('=== Testing location_data CTE ===');
    const locationDataQuery = `
      WITH location_data AS (
        SELECT 
          COALESCE(vr.location, 'unknown') as location,
          bp.validator_id,
          'block' as source
        FROM block_proposals bp
        LEFT JOIN validator_registry vr ON bp.validator_id = vr.validator_id
        WHERE bp.timestamp >= now() - INTERVAL 24 HOUR
          AND vr.location IS NOT NULL AND vr.location != '' AND vr.location != 'unknown'
        
        UNION DISTINCT
        
        SELECT 
          COALESCE(vr.location, 'unknown') as location,
          qc.validator_id,
          'qc' as source
        FROM qc_participation qc
        LEFT JOIN validator_registry vr ON qc.validator_id = vr.validator_id
        WHERE qc.timestamp >= now() - INTERVAL 24 HOUR
          AND vr.location IS NOT NULL AND vr.location != '' AND vr.location != 'unknown'
      )
      SELECT location, COUNT(DISTINCT validator_id) as validator_count
      FROM location_data 
      GROUP BY location
      ORDER BY validator_count DESC
      LIMIT 5
    `;
    
    const locationResult = await client.executeRawQuery(locationDataQuery);
    console.log('Location data result:', locationResult);

    // Test the full query but simpler
    console.log('\n=== Testing simplified version ===');
    const simpleQuery = `
      SELECT 
        COALESCE(location, 'unknown') as location,
        COUNT(DISTINCT validator_id) as validator_count,
        COUNT(*) as total_events
      FROM (
        SELECT bp.validator_id, COALESCE(vr.location, 'unknown') as location 
        FROM block_proposals bp
        LEFT JOIN validator_registry vr ON bp.validator_id = vr.validator_id
        WHERE bp.timestamp >= now() - INTERVAL 24 HOUR
          AND vr.location IS NOT NULL AND vr.location != '' AND vr.location != 'unknown'
        UNION DISTINCT
        SELECT qc.validator_id, COALESCE(vr.location, 'unknown') as location 
        FROM qc_participation qc
        LEFT JOIN validator_registry vr ON qc.validator_id = vr.validator_id
        WHERE qc.timestamp >= now() - INTERVAL 24 HOUR
          AND vr.location IS NOT NULL AND vr.location != '' AND vr.location != 'unknown'
      ) combined
      GROUP BY location
      ORDER BY validator_count DESC
      LIMIT 5
    `;
    
    const simpleResult = await client.executeRawQuery(simpleQuery);
    console.log('Simple query result:', simpleResult);

    // Test location-based queries on existing data
    console.log('\n=== Testing location-based queries ===');
    try {
      const locationQuery = `
        SELECT bp.validator_id, COALESCE(vr.location, 'unknown') as location 
        FROM block_proposals bp
        LEFT JOIN validator_registry vr ON bp.validator_id = vr.validator_id
        WHERE bp.timestamp >= now() - INTERVAL 7 DAY 
        LIMIT 10
      `;
      
      const qcLocationQuery = `
        SELECT qc.validator_id, COALESCE(vr.location, 'unknown') as location 
        FROM qc_participation qc
        LEFT JOIN validator_registry vr ON qc.validator_id = vr.validator_id
        WHERE qc.timestamp >= now() - INTERVAL 7 DAY 
        LIMIT 10
      `;
    } catch (error) {
      console.error('❌ Error:', error);
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

debugGeoQuery().then(() => {
  console.log('\n✅ Debug complete');
  process.exit(0);
}).catch(error => {
  console.error('❌ Script failed:', error);
  process.exit(1);
}); 