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

    // =============================================
    // CHECK BLOCK PROPOSALS TABLE
    // =============================================
    if (tables.some(t => t.name === 'block_proposals')) {
      console.log('\n🏗️  BLOCK PROPOSALS DATA:');
      
      const countQuery = 'SELECT COUNT(*) as count FROM block_proposals';
      const countResult = await client['client'].query({
        query: countQuery,
        format: 'JSONEachRow'
      });
      const countData = await countResult.json() as any[];
      console.log('📈 Total block proposals:', countData[0]?.count || 0);

      // Check recent block proposals
      const recentQuery = `
        SELECT 
          timestamp,
          validator_id,
          seq_num,
          round,
          epoch,
          status,
          num_tx,
          block_id,
          provider,
          location
        FROM block_proposals 
        ORDER BY timestamp DESC 
        LIMIT 5
      `;
      
      const recentResult = await client['client'].query({
        query: recentQuery,
        format: 'JSONEachRow'
      });
      const recentData = await recentResult.json() as any[];
      console.log('🔄 Recent block proposals:');
      recentData.forEach((event, i) => {
        console.log(`  ${i + 1}. ${event.timestamp} - Seq: ${event.seq_num} - Round: ${event.round} - Status: ${event.status} - Validator: ${event.validator_id.substring(0, 8)}...`);
      });

      // Check status distribution
      const statusQuery = `
        SELECT 
          status,
          COUNT(*) as count
        FROM block_proposals 
        GROUP BY status 
        ORDER BY count DESC
      `;
      
      const statusResult = await client['client'].query({
        query: statusQuery,
        format: 'JSONEachRow'
      });
      const statusData = await statusResult.json() as any[];
      console.log('📊 Block proposal status distribution:');
      statusData.forEach(s => {
        console.log(`  ${s.status}: ${s.count}`);
      });

      // Check last 24 hours
      const last24hQuery = `
        SELECT COUNT(*) as count 
        FROM block_proposals 
        WHERE timestamp >= now() - INTERVAL 24 HOUR
      `;
      
      const last24hResult = await client['client'].query({
        query: last24hQuery,
        format: 'JSONEachRow'
      });
      const last24hData = await last24hResult.json() as any[];
      console.log('⏰ Block proposals in last 24 hours:', last24hData[0]?.count || 0);

    } else {
      console.log('❌ block_proposals table does not exist');
    }

    // =============================================
    // CHECK QC PARTICIPATION TABLE
    // =============================================
    if (tables.some(t => t.name === 'qc_participation')) {
      console.log('\n🗳️  QC PARTICIPATION DATA:');
      
      const countQuery = 'SELECT COUNT(*) as count FROM qc_participation';
      const countResult = await client['client'].query({
        query: countQuery,
        format: 'JSONEachRow'
      });
      const countData = await countResult.json() as any[];
      console.log('📈 Total QC participation records:', countData[0]?.count || 0);

      // Check recent QC participation
      const recentQuery = `
        SELECT 
          timestamp,
          validator_id,
          seq_num,
          round,
          epoch,
          participated,
          validator_index,
          total_validators,
          participating_validators,
          participation_rate
        FROM qc_participation 
        ORDER BY timestamp DESC 
        LIMIT 5
      `;
      
      const recentResult = await client['client'].query({
        query: recentQuery,
        format: 'JSONEachRow'
      });
      const recentData = await recentResult.json() as any[];
      console.log('🔄 Recent QC participation:');
      recentData.forEach((event, i) => {
        console.log(`  ${i + 1}. ${event.timestamp} - Round: ${event.round} - Participated: ${event.participated ? 'YES' : 'NO'} - Rate: ${event.participation_rate.toFixed(1)}%`);
      });

      // Check participation rate statistics
      const participationStatsQuery = `
        SELECT 
          AVG(participation_rate) as avg_rate,
          MIN(participation_rate) as min_rate,
          MAX(participation_rate) as max_rate,
          COUNT(CASE WHEN participated = 1 THEN 1 END) as participated_count,
          COUNT(CASE WHEN participated = 0 THEN 1 END) as not_participated_count
        FROM qc_participation
      `;
      
      const participationStatsResult = await client['client'].query({
        query: participationStatsQuery,
        format: 'JSONEachRow'
      });
      const participationStatsData = await participationStatsResult.json() as any[];
      if (participationStatsData[0]) {
        const stats = participationStatsData[0];
        console.log('📊 QC Participation Statistics:');
        console.log(`  Average participation rate: ${stats.avg_rate?.toFixed(1) || 0}%`);
        console.log(`  Min participation rate: ${stats.min_rate?.toFixed(1) || 0}%`);
        console.log(`  Max participation rate: ${stats.max_rate?.toFixed(1) || 0}%`);
        console.log(`  Validators who participated: ${stats.participated_count || 0}`);
        console.log(`  Validators who didn't participate: ${stats.not_participated_count || 0}`);
      }

      // Check last 24 hours
      const last24hQuery = `
        SELECT COUNT(*) as count 
        FROM qc_participation 
        WHERE timestamp >= now() - INTERVAL 24 HOUR
      `;
      
      const last24hResult = await client['client'].query({
        query: last24hQuery,
        format: 'JSONEachRow'
      });
      const last24hData = await last24hResult.json() as any[];
      console.log('⏰ QC participation records in last 24 hours:', last24hData[0]?.count || 0);

    } else {
      console.log('❌ qc_participation table does not exist');
    }

    // =============================================
    // CHECK VALIDATOR DISTRIBUTION ACROSS TABLES
    // =============================================
    console.log('\n👥 VALIDATOR ANALYTICS:');
    
    // Top validators by block proposals
    if (tables.some(t => t.name === 'block_proposals')) {
      const topProposersQuery = `
        SELECT 
          validator_id,
          COUNT(*) as proposal_count,
          COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_proposals,
          COUNT(CASE WHEN status = 'skipped' THEN 1 END) as skipped_proposals,
          (COUNT(CASE WHEN status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as success_rate
        FROM block_proposals 
        GROUP BY validator_id 
        ORDER BY proposal_count DESC
        LIMIT 10
      `;
      
      const topProposersResult = await client['client'].query({
        query: topProposersQuery,
        format: 'JSONEachRow'
      });
      const topProposersData = await topProposersResult.json() as any[];
      console.log('🏆 Top validators by block proposals:');
      topProposersData.forEach((v, i) => {
        console.log(`  ${i + 1}. ${v.validator_id.substring(0, 12)}... - ${v.proposal_count} proposals (${v.success_rate.toFixed(1)}% success)`);
      });
    }

    // Geographic distribution
    if (tables.some(t => t.name === 'block_proposals')) {
      const geoQuery = `
        SELECT 
          location,
          provider,
          COUNT(DISTINCT validator_id) as validator_count,
          COUNT(*) as total_proposals
        FROM block_proposals 
        WHERE location != 'unknown'
        GROUP BY location, provider
        ORDER BY validator_count DESC, total_proposals DESC
        LIMIT 10
      `;
      
      const geoResult = await client['client'].query({
        query: geoQuery,
        format: 'JSONEachRow'
      });
      const geoData = await geoResult.json() as any[];
      console.log('🌍 Geographic distribution:');
      geoData.forEach((g, i) => {
        console.log(`  ${i + 1}. ${g.location} (${g.provider}) - ${g.validator_count} validators, ${g.total_proposals} proposals`);
      });
    }

    // Check legacy validator_events table for comparison
    if (tables.some(t => t.name === 'validator_events')) {
      const legacyCountQuery = 'SELECT COUNT(*) as count FROM validator_events';
      const legacyCountResult = await client['client'].query({
        query: legacyCountQuery,
        format: 'JSONEachRow'
      });
      const legacyCountData = await legacyCountResult.json() as any[];
      console.log('\n📊 Legacy validator_events table:', legacyCountData[0]?.count || 0, 'records');
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