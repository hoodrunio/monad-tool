// Monad Validator Analytics - ClickHouse Database Client
// High-performance database client with connection pooling and query optimization

import { createClient, ClickHouseClient } from '@clickhouse/client';
import { ConsensusEvent, LedgerEvent, QCParticipationData, ValidatorInfrastructure } from '../log-processor/types';

export interface ClickHouseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  max_open_connections: number;
  max_query_timeout: number;
  compression: boolean;
}

export class MonadClickHouseClient {
  private client: ClickHouseClient;
  private config: ClickHouseConfig;

  constructor(config: ClickHouseConfig) {
    this.config = config;
    this.client = createClient({
      host: `http://${config.host}:${config.port}`,
      username: config.username,
      password: config.password,
      database: config.database,
      max_open_connections: config.max_open_connections,
      request_timeout: config.max_query_timeout,
      compression: {
        request: config.compression,
        response: config.compression
      }
    });
  }

  // =============================================
  // SCHEMA INITIALIZATION
  // =============================================

  async initializeSchema(): Promise<void> {
    console.log('Initializing ClickHouse schema...');
    
    try {
      // Create database
      await this.client.command({
        query: `CREATE DATABASE IF NOT EXISTS ${this.config.database}`
      });

      // Execute schema creation
      const schemaStatements = await this.loadSchemaStatements();
      
      for (const statement of schemaStatements) {
        if (statement.trim().length > 0) {
          await this.client.command({ query: statement });
        }
      }
      
      console.log('Schema initialized successfully');
    } catch (error) {
      console.error('Failed to initialize schema:', error);
      throw error;
    }
  }

  private async loadSchemaStatements(): Promise<string[]> {
    // Return individual SQL statements
    return [
      `USE ${this.config.database}`,
      
      `CREATE TABLE IF NOT EXISTS raw_logs (
        timestamp DateTime64(3, 'UTC'),
        log_source Enum8('consensus' = 1, 'ledger_tail' = 2),
        log_level Enum8('DEBUG' = 1, 'INFO' = 2, 'WARN' = 3, 'ERROR' = 4),
        log_target String,
        raw_content String CODEC(ZSTD(1)),
        parsed_at DateTime64(3, 'UTC') DEFAULT now(),
        ingestion_id UUID DEFAULT generateUUIDv4(),
        parsing_status Enum8('pending' = 1, 'success' = 2, 'failed' = 3, 'partial' = 4) DEFAULT 'pending',
        parsing_error Nullable(String)
      ) ENGINE = ReplacingMergeTree(parsed_at)
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (timestamp, log_source, ingestion_id)
      TTL toDateTime(timestamp) + INTERVAL 7 DAY`,
      
      `CREATE TABLE IF NOT EXISTS validator_events (
        timestamp DateTime64(3, 'UTC'),
        event_type Enum16(
          'vote_attempt' = 1, 'vote_result' = 2, 'vote_created' = 3,
          'proposal_received' = 4, 'proposal_detailed' = 5, 'proposal_validated' = 6,
          'qc_commit_attempt' = 7, 'qc_commit_triggered' = 8,
          'block_proposal' = 10, 'block_committed' = 11, 'block_skipped' = 12,
          'block_sequence_committed' = 13, 'txpool_updated' = 20,
          'telemetry_export' = 30, 'metrics_collected' = 31
        ),
        validator_id String,
        round_number UInt64,
        epoch_number UInt32,
        block_number Nullable(UInt64),
        block_id Nullable(String),
        parent_vote_id Nullable(String),
        parent_round Nullable(UInt64),
        next_leader_id Nullable(String),
        block_timestamp_ms Nullable(UInt64),
        processing_timestamp_ms UInt64,
        processing_delay_ms UInt32,
        transaction_count UInt32 DEFAULT 0,
        state_root_action LowCardinality(String),
        sequence_number Nullable(UInt64),
        validator_dns String,
        geographic_region LowCardinality(String),
        infrastructure_provider LowCardinality(String),
        datacenter_code LowCardinality(String),
        is_successful UInt8 DEFAULT 1,
        participant_count Nullable(UInt16),
        participation_rate Nullable(Float32),
        metadata String CODEC(ZSTD(1)),
        ingestion_id UUID,
        processed_at DateTime64(3, 'UTC') DEFAULT now()
      ) ENGINE = MergeTree()
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (timestamp, validator_id, event_type, round_number)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY`
    ];
  }

  // =============================================
  // DATA INSERTION METHODS
  // =============================================

  async insertValidatorEvents(events: ConsensusEvent[]): Promise<void> {
    if (events.length === 0) return;

    const data = events.map(event => ({
      timestamp: this.formatTimestamp(event.timestamp),
      event_type: event.eventType,
      validator_id: event.validatorId,
      round_number: event.roundNumber,
      epoch_number: event.epochNumber,
      block_number: event.blockNumber || null,
      block_id: event.blockId || null,
      parent_vote_id: event.parentVoteId || null,
      parent_round: event.parentRound || null,
      next_leader_id: event.nextLeaderId || null,
      block_timestamp_ms: event.blockTimestampMs || null,
      processing_timestamp_ms: event.processingTimestampMs,
      processing_delay_ms: event.processingDelayMs,
      transaction_count: event.transactionCount,
      state_root_action: event.stateRootAction || '',
      sequence_number: event.sequenceNumber || null,
      validator_dns: event.validatorDns,
      geographic_region: event.geographicRegion,
      infrastructure_provider: event.infrastructureProvider,
      datacenter_code: event.datacenterCode,
      is_successful: event.isSuccessful ? 1 : 0,
      participant_count: event.participantCount || null,
      participation_rate: event.participationRate || null,
      metadata: event.metadata,
      ingestion_id: event.ingestionId
    }));

    await this.client.insert({
      table: 'validator_events',
      values: data,
      format: 'JSONEachRow'
    });
  }

  async insertLedgerEvents(events: LedgerEvent[]): Promise<void> {
    if (events.length === 0) return;

    const data = events.map(event => ({
      timestamp: this.formatTimestamp(event.timestamp),
      event_type: event.eventType,
      validator_id: event.validatorId,
      round_number: event.roundNumber,
      epoch_number: event.epochNumber,
      block_number: event.blockNumber || null,
      parent_round: event.parentRound || null,
      sequence_number: event.sequenceNumber || null,
      transaction_count: event.transactionCount,
      block_timestamp_ms: event.blockTimestampMs,
      processing_timestamp_ms: event.processingTimestampMs,
      processing_delay_ms: event.processingDelayMs,
      validator_dns: event.validatorDns,
      geographic_region: event.geographicRegion,
      infrastructure_provider: event.infrastructureProvider,
      datacenter_code: event.datacenterCode,
      ingestion_id: event.ingestionId
    }));

    // Insert as consensus events (they share the same table)
    await this.client.insert({
      table: 'validator_events',
      values: data,
      format: 'JSONEachRow'
    });
  }

  async insertQCParticipation(qcData: QCParticipationData[]): Promise<void> {
    if (qcData.length === 0) return;

    const data = qcData.map(qc => ({
      timestamp: new Date(),
      round_number: 0, // Would need round from context
      qc_vote_id: '',
      epoch_number: 1,
      total_validators: qc.totalValidators,
      participating_validators: qc.participatingValidators,
      participation_bitmap: qc.participationBitmap,
      participation_rate: qc.participationRate,
      bls_signature: qc.blsSignature,
      signature_verification_time_ns: qc.signatureVerificationTimeNs || null,
      qc_assembly_time_ms: qc.qcAssemblyTimeMs,
      validator_participation: qc.validatorParticipation.map(v => [v.validatorId, v.participated ? 1 : 0]),
      consensus_latency_ms: 0,
      block_id: '',
      proposer_id: ''
    }));

    await this.client.insert({
      table: 'qc_participation',
      values: data,
      format: 'JSONEachRow'
    });
  }

  async insertValidatorInfrastructure(validators: ValidatorInfrastructure[]): Promise<void> {
    if (validators.length === 0) return;

    const now = new Date();
    const data = validators.map(validator => ({
      validator_id: validator.validatorId,
      dns_name: validator.dnsName,
      geographic_region: validator.geographicRegion,
      datacenter_location: validator.datacenterCode,
      infrastructure_provider: validator.infrastructureProvider,
      provider_type: validator.providerType,
      endpoint_host: validator.endpointHost,
      endpoint_port: validator.endpointPort,
      first_seen: this.formatTimestamp(now),
      last_active: this.formatTimestamp(now),
      is_active: 1,
      activity_score: 100.0,
      version: Date.now()
    }));

    await this.client.insert({
      table: 'validators',
      values: data,
      format: 'JSONEachRow'
    });
  }

  // =============================================
  // QUERY METHODS
  // =============================================

  async getValidatorRankings(timeWindow: '1m' | '1h' | '24h' = '1h', limit: number = 50): Promise<any[]> {
    const query = `
      SELECT 
        validator_id,
        any(geographic_region) as region,
        any(infrastructure_provider) as provider,
        countMerge(blocks_proposed) as total_proposals,
        countMerge(blocks_committed) as successful_commits,
        countMerge(votes_successful) as successful_votes,
        avgMerge(avg_vote_latency) as avg_latency,
        avgMerge(avg_qc_participation_rate) as participation_rate,
        (successful_commits / total_proposals) * 100 as success_rate
      FROM validator_performance_agg
      WHERE time_window = '${timeWindow}'
        AND timestamp >= now() - INTERVAL 1 ${timeWindow === '1m' ? 'HOUR' : timeWindow === '1h' ? 'DAY' : 'WEEK'}
      GROUP BY validator_id
      ORDER BY success_rate DESC, participation_rate DESC
      LIMIT ${limit}
    `;

    const result = await this.client.query({
      query,
      format: 'JSONEachRow'
    });

    return result.json();
  }

  async getNetworkMetrics(timeWindow: '1m' | '1h' | '24h' = '1h'): Promise<any> {
    const query = `
      SELECT 
        uniqMerge(total_rounds) as total_rounds,
        countMerge(successful_rounds) as successful_rounds,
        avgMerge(avg_round_time) as avg_round_time_ms,
        avgMerge(avg_qc_participation_rate) as avg_participation_rate,
        countMerge(total_blocks) as total_blocks,
        avgMerge(avg_block_time) as avg_block_time_ms,
        uniqMerge(active_validators) as active_validators,
        uniqMerge(active_regions) as active_regions,
        avgMerge(consensus_efficiency) as consensus_efficiency,
        quantileMerge(0.95)(network_latency_p95) as latency_p95
      FROM network_metrics_agg
      WHERE time_window = '${timeWindow}'
        AND timestamp >= now() - INTERVAL 1 ${timeWindow === '1m' ? 'HOUR' : timeWindow === '1h' ? 'DAY' : 'WEEK'}
    `;

    const result = await this.client.query({
      query,
      format: 'JSONEachRow'
    });

    const rows = await result.json<any[]>();
    return rows[0] || {};
  }

  async getGeographicDistribution(): Promise<any[]> {
    const query = `
      SELECT 
        geographic_region,
        uniqMerge(active_validators) as validator_count,
        uniqMerge(infrastructure_providers) as provider_count,
        avgMerge(avg_latency) as avg_latency_ms,
        avgMerge(qc_participation_rate) as participation_rate,
        countMerge(total_proposals) as total_proposals
      FROM geographic_metrics
      WHERE time_window = '1h'
        AND timestamp >= now() - INTERVAL 24 HOUR
      GROUP BY geographic_region
      ORDER BY validator_count DESC
    `;

    const result = await this.client.query({
      query,
      format: 'JSONEachRow'
    });

    return result.json();
  }

  async getValidatorHistory(validatorId: string, hours: number = 24): Promise<any[]> {
    const query = `
      SELECT 
        timestamp,
        event_type,
        round_number,
        processing_delay_ms,
        is_successful,
        participation_rate
      FROM validator_events
      WHERE validator_id = '${validatorId}'
        AND timestamp >= now() - INTERVAL ${hours} HOUR
      ORDER BY timestamp DESC
      LIMIT 1000
    `;

    const result = await this.client.query({
      query,
      format: 'JSONEachRow'
    });

    return result.json();
  }

  async getHealthAlerts(): Promise<any[]> {
    const query = `
      SELECT 
        alert_type,
        metric_value,
        alert_level,
        sample_count,
        timestamp
      FROM network_health_alerts_mv
      WHERE timestamp >= now() - INTERVAL 1 HOUR
        AND alert_level IN ('warning', 'critical')
      ORDER BY timestamp DESC
      LIMIT 100
    `;

    const result = await this.client.query({
      query,
      format: 'JSONEachRow'
    });

    return result.json();
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  private formatTimestamp(date: Date): string {
    // Format Date to ClickHouse DateTime64 format: 'YYYY-MM-DD HH:mm:ss.SSS'
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      console.error('ClickHouse ping failed:', error);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // =============================================
  // RAW QUERY METHODS FOR SYSTEM OPERATIONS
  // =============================================

  async executeRawQuery(query: string): Promise<any[]> {
    const result = await this.client.query({
      query,
      format: 'JSONEachRow'
    });

    return result.json();
  }

  async executeCommand(command: string): Promise<void> {
    await this.client.command({ query: command });
  }

  async getTableStats(): Promise<any[]> {
    const query = `
      SELECT 
        database,
        table,
        engine,
        total_rows,
        total_bytes,
        formatReadableSize(total_bytes) as readable_size
      FROM system.tables
      WHERE database = '${this.config.database}'
        AND engine LIKE '%MergeTree%'
      ORDER BY total_bytes DESC
    `;

    const result = await this.client.query({
      query,
      format: 'JSONEachRow'
    });

    return result.json();
  }
} 