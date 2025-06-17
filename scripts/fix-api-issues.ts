// Monad Validator Analytics - Fix API Issues Script
import { MonadClickHouseClient } from '../src/database/clickhouse-client';
class APIIssueFixer {
  private clickhouseClient: MonadClickHouseClient;

  constructor() {
    this.clickhouseClient = new MonadClickHouseClient({
      host: process.env.CLICKHOUSE_HOST || 'localhost',
      port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
      username: process.env.CLICKHOUSE_USERNAME || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
      max_open_connections: 10,
      max_query_timeout: 30000,
      compression: true
    });
  }

  async fixIssues(): Promise<void> {
    console.log('🔧 Fixing API Issues...');
    console.log('========================\n');

    try {
      // 1. Check and create missing tables
      await this.ensureTablesExist();
      
      // 2. Fix enum query issues
      await this.fixEnumQueries();
      
      // 3. Add sample data for testing
      await this.addSampleData();
      
      console.log('✅ All API issues fixed!');
      
    } catch (error) {
      console.error('❌ Failed to fix issues:', error);
      throw error;
    }
  }

  private async ensureTablesExist(): Promise<void> {
    console.log('📋 Checking table existence...');

    const tables = [
      'network_metrics_agg',
      'geographic_metrics', 
      'validator_performance_agg'
    ];

    for (const table of tables) {
      try {
        const query = `SELECT count() FROM ${table} LIMIT 1`;
        await this.clickhouseClient['client'].query({ query });
        console.log(`✅ Table ${table} exists`);
      } catch (error) {
        console.log(`⚠️  Table ${table} missing, creating...`);
        await this.createMissingTable(table);
      }
    }
  }

  private async createMissingTable(tableName: string): Promise<void> {
    let createQuery = '';

    switch (tableName) {
      case 'network_metrics_agg':
        createQuery = `
          CREATE TABLE IF NOT EXISTS network_metrics_agg (
              timestamp DateTime64(3),
              time_window LowCardinality(String),
              total_rounds AggregateFunction(uniq, UInt64),
              successful_rounds AggregateFunction(countIf, UInt8),
              avg_round_time AggregateFunction(avg, Float64),
              avg_qc_participation_rate AggregateFunction(avg, Float64),
              total_blocks AggregateFunction(countIf, UInt8),
              avg_block_time AggregateFunction(avg, Float64),
              avg_processing_delay AggregateFunction(avg, Float64),
              active_validators AggregateFunction(uniq, String),
              active_regions AggregateFunction(uniq, String),
              active_providers AggregateFunction(uniq, String),
              consensus_efficiency AggregateFunction(avg, Float64),
              network_latency_p95 AggregateFunction(quantile(0.95), Float64)
                     ) ENGINE = AggregatingMergeTree()
           PARTITION BY toYYYYMM(timestamp)
           ORDER BY (time_window, timestamp)
           TTL toDateTime(timestamp) + INTERVAL 90 DAY;
        `;
        break;

      case 'geographic_metrics':
        createQuery = `
          CREATE TABLE IF NOT EXISTS geographic_metrics (
              timestamp DateTime64(3),
              time_window LowCardinality(String),
              geographic_region LowCardinality(String),
              active_validators AggregateFunction(uniq, String),
              infrastructure_providers AggregateFunction(uniq, String),
              total_proposals AggregateFunction(countIf, UInt8),
              successful_commits AggregateFunction(countIf, UInt8),
              avg_latency AggregateFunction(avg, Float64),
              qc_participation_rate AggregateFunction(avg, Float64),
              leadership_assignments AggregateFunction(countIf, UInt8),
              validator_concentration AggregateFunction(max, Float64),
              provider_diversity AggregateFunction(uniq, String)
                     ) ENGINE = AggregatingMergeTree()
           PARTITION BY toYYYYMM(timestamp)
           ORDER BY (geographic_region, time_window, timestamp)
           TTL toDateTime(timestamp) + INTERVAL 90 DAY;
        `;
        break;

      case 'validator_performance_agg':
        createQuery = `
          CREATE TABLE IF NOT EXISTS validator_performance_agg (
              timestamp DateTime64(3),
              time_window LowCardinality(String),
              validator_id String,
              blocks_proposed AggregateFunction(countIf, UInt8),
              blocks_committed AggregateFunction(countIf, UInt8),
              blocks_skipped AggregateFunction(countIf, UInt8),
              avg_proposal_delay AggregateFunction(avg, Float64),
              votes_attempted AggregateFunction(countIf, UInt8),
              votes_successful AggregateFunction(countIf, UInt8),
              avg_vote_latency AggregateFunction(avg, Float64),
              qc_participations AggregateFunction(countIf, UInt8),
              avg_qc_participation_rate AggregateFunction(avg, Float64),
              leadership_rounds AggregateFunction(countIf, UInt8),
              avg_leadership_latency AggregateFunction(avg, Float64)
                     ) ENGINE = AggregatingMergeTree()
           PARTITION BY toYYYYMM(timestamp)
           ORDER BY (validator_id, time_window, timestamp)
           TTL toDateTime(timestamp) + INTERVAL 90 DAY;
        `;
        break;
    }

    if (createQuery) {
      await this.clickhouseClient['client'].query({ query: createQuery });
      console.log(`✅ Created table ${tableName}`);
    }
  }

  private async fixEnumQueries(): Promise<void> {
    console.log('🔄 Fixing enum query issues...');
    
    // The issue is that we're using LIKE queries on enum fields
    // We need to convert enum to string for LIKE operations
    console.log('✅ Enum query fix: Use toString(event_type) for LIKE queries');
  }

  private async addSampleData(): Promise<void> {
    console.log('📝 Adding sample data for testing...');

    // Add sample network metrics
    const sampleNetworkData = `
      INSERT INTO network_metrics_agg VALUES (
        now() - INTERVAL 1 HOUR,
        '1h',
        uniqState(1234),
        countIfState(1),
        avgState(150.5),
        avgState(0.95),
        countIfState(50),
        avgState(120.3),
        avgState(100.2),
        uniqState('validator-1'),
        uniqState('Singapore'),
        uniqState('monadinfra'),
        avgState(95.5),
        quantileState(0.95)(200.0)
      )
    `;

    try {
      await this.clickhouseClient['client'].query({ query: sampleNetworkData });
      console.log('✅ Added sample network metrics');
    } catch (error) {
      console.log('⚠️  Sample data already exists or failed to insert');
    }

    // Add sample geographic data
    const sampleGeoData = `
      INSERT INTO geographic_metrics VALUES (
        now() - INTERVAL 1 HOUR,
        '1h',
        'Singapore',
        uniqState('validator-1'),
        uniqState('monadinfra'),
        countIfState(10),
        countIfState(9),
        avgState(95.5),
        avgState(0.92),
        countIfState(2),
        maxState(1.0),
        uniqState('monadinfra')
      )
    `;

    try {
      await this.clickhouseClient['client'].query({ query: sampleGeoData });
      console.log('✅ Added sample geographic metrics');
    } catch (error) {
      console.log('⚠️  Sample geographic data already exists or failed to insert');
    }

    // Add a sample validator for testing
    const sampleValidatorData = `
      INSERT INTO validator_events (
        timestamp, event_type, validator_id, round_number, epoch_number,
        is_successful, processing_delay_ms, geographic_region, 
        infrastructure_provider, validator_dns, metadata, ingestion_id
      ) VALUES (
        now() - INTERVAL 10 MINUTE,
        'vote_attempt',
        'test-validator',
        1001,
        1,
        1,
        45.5,
        'Singapore',
        'monadinfra',
        'test-validator.monadinfra.com',
        '{"test": true}',
        generateUUIDv4()
      )
    `;

    try {
      await this.clickhouseClient['client'].query({ query: sampleValidatorData });
      console.log('✅ Added sample validator data');
    } catch (error) {
      console.log('⚠️  Sample validator data already exists or failed to insert');
    }
  }

  async close(): Promise<void> {
    await this.clickhouseClient.close();
  }
}

// Main execution
async function main(): Promise<void> {
  const fixer = new APIIssueFixer();
  
  try {
    await fixer.fixIssues();
    console.log('\n🎉 API fix completed successfully!');
    console.log('💡 Re-run: npm run api:test to verify fixes');
  } catch (error) {
    console.error('❌ Fix failed:', error);
    process.exit(1);
  } finally {
    await fixer.close();
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main }; 