// Monad Validator Analytics - ClickHouse Database Client
// High-performance database client with connection pooling and query optimization

import { createClient, ClickHouseClient } from '@clickhouse/client';
import { Mutex } from 'async-mutex';
import { ConsensusEvent, LedgerEvent, QCParticipationData, ValidatorInfrastructure, BlockProposalEvent, QCParticipationEvent } from '../log-processor/types';
import { CompleteValidator } from '../services/unified-validator';
import { logger } from '../utils/logger';
import { MigrationRunner } from './migrations';

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
  private authAddressColumnEnsured = false;
  private rebuildMutex = new Mutex();

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

  getDatabaseName(): string {
    return this.config.database;
  }

  getClient(): ClickHouseClient {
    return this.client;
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

      // Run migrations before schema creation
      const migrationRunner = new MigrationRunner(this.client, this.config.database);
      await migrationRunner.runMigrations();

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
      TTL toDateTime(timestamp) + INTERVAL 30 DAY`,

      `CREATE TABLE IF NOT EXISTS validator_info_cache (
        node_id String,
        epoch UInt32,
        
        -- From ValidatorRegistry
        stake UInt64,
        cert_pubkey String,
        position UInt16,
        
        -- From DNSMapper
        dns_address String,
        dns_host String,
        dns_port UInt16,
        provider LowCardinality(String),
        location String,
        country LowCardinality(String),
        city LowCardinality(String),
        datacenter LowCardinality(String),
        
        -- Cache metadata
        is_active UInt8 DEFAULT 1,
        last_seen DateTime64(3, 'UTC'),
        processed_count UInt32 DEFAULT 1,
        created_at DateTime64(3, 'UTC') DEFAULT now(),
        updated_at DateTime64(3, 'UTC') DEFAULT now()
      ) ENGINE = ReplacingMergeTree(updated_at)
      PARTITION BY epoch
      ORDER BY (node_id, epoch)
      TTL toDateTime(updated_at) + INTERVAL 7 DAY`,

      `CREATE TABLE IF NOT EXISTS block_proposals (
        timestamp DateTime64(3, 'UTC'),
        validator_id String,
        seq_num UInt64,
        round UInt64,
        epoch UInt64,
        
        -- Proposal status: proposed or skipped
        status Enum8('proposed' = 1, 'skipped' = 2),
        num_tx UInt32 DEFAULT 0,
        block_id Nullable(String),
        
        -- Processing metadata
        ingestion_id UUID DEFAULT generateUUIDv4(),
        processed_at DateTime64(3, 'UTC') DEFAULT now()
      ) ENGINE = MergeTree()
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (seq_num, validator_id)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
      SETTINGS index_granularity = 8192`,

      `CREATE TABLE IF NOT EXISTS qc_participation (
        timestamp DateTime64(3, 'UTC'),
        seq_num UInt64,
        round UInt64,
        epoch UInt64,
        validator_id String,
        validator_index UInt32,

        -- Participation: 1 = participated, 0 = did not participate
        participated UInt8,

        -- QC metadata
        qc_id String,
        total_validators UInt16,
        participating_validators UInt16,
        participation_rate Float32,

        -- Processing metadata
        ingestion_id UUID DEFAULT generateUUIDv4(),
        processed_at DateTime64(3, 'UTC') DEFAULT now()
      ) ENGINE = MergeTree()
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (seq_num, validator_id)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
      SETTINGS index_granularity = 8192`,

      // =============================================
      // STAKING EVENTS TABLES
      // =============================================

      `CREATE TABLE IF NOT EXISTS staking_events (
        event_id String,
        event_type Enum8(
          'ValidatorCreated' = 1,
          'ValidatorStatusChanged' = 2,
          'Delegate' = 3,
          'Undelegate' = 4,
          'Withdraw' = 5,
          'ClaimRewards' = 6,
          'CommissionChanged' = 7,
          'ValidatorRewarded' = 8,
          'EpochChanged' = 9
        ),
        block_number UInt64,
        block_timestamp DateTime64(3, 'UTC'),
        transaction_hash String,
        log_index UInt32,
        epoch String,

        -- Event-specific data (nullable for flexibility)
        validator_id Nullable(String),
        delegator Nullable(String),
        amount Nullable(String),
        commission Nullable(String),
        old_commission Nullable(String),
        new_commission Nullable(String),
        activation_epoch Nullable(String),
        withdraw_id Nullable(UInt8),
        flags Nullable(String),
        from_address Nullable(String),
        old_epoch Nullable(String),
        new_epoch Nullable(String),

        -- Processing metadata
        processed_at DateTime64(3, 'UTC') DEFAULT now()
      ) ENGINE = ReplacingMergeTree(processed_at)
      PARTITION BY toYYYYMM(block_timestamp)
      ORDER BY (event_id, event_type, block_number)
      TTL toDateTime(block_timestamp) + INTERVAL 90 DAY
      SETTINGS index_granularity = 8192`,

      `CREATE TABLE IF NOT EXISTS validator_delegations (
        validator_id String,
        delegator String,
        current_amount String,
        total_delegated String,
        total_undelegated String,
        total_withdrawn String,
        total_rewards_claimed String,
        pending_withdrawals UInt32,
        first_delegation_at DateTime64(3, 'UTC'),
        last_updated_at DateTime64(3, 'UTC'),
        last_updated_block UInt64,
        epoch String
      ) ENGINE = ReplacingMergeTree(last_updated_at)
      PARTITION BY toYYYYMM(last_updated_at)
      ORDER BY (validator_id, delegator)
      SETTINGS index_granularity = 8192`,

      `CREATE TABLE IF NOT EXISTS delegation_history (
        history_id String,
        validator_id String,
        delegator String,
        action Enum8('delegate' = 1, 'undelegate' = 2, 'withdraw' = 3, 'compound' = 4),
        amount String,
        epoch String,
        activation_epoch Nullable(String),
        withdraw_id Nullable(UInt8),
        block_number UInt64,
        block_timestamp DateTime64(3, 'UTC'),
        transaction_hash String
      ) ENGINE = MergeTree()
      PARTITION BY toYYYYMM(block_timestamp)
      ORDER BY (validator_id, delegator, block_number)
      TTL toDateTime(block_timestamp) + INTERVAL 180 DAY
      SETTINGS index_granularity = 8192`,

      `CREATE TABLE IF NOT EXISTS reward_events (
        event_id String,
        validator_id String,
        delegator Nullable(String),
        amount String,
        epoch String,
        event_type Enum8('claim' = 1, 'commission_change' = 2, 'validator_reward' = 3),
        old_commission Nullable(String),
        new_commission Nullable(String),
        block_number UInt64,
        block_timestamp DateTime64(3, 'UTC'),
        transaction_hash String
      ) ENGINE = MergeTree()
      PARTITION BY toYYYYMM(block_timestamp)
      ORDER BY (validator_id, event_type, block_number)
      TTL toDateTime(block_timestamp) + INTERVAL 90 DAY
      SETTINGS index_granularity = 8192`,

      // =============================================
      // VALIDATOR REGISTRY TABLES
      // =============================================

      `CREATE TABLE IF NOT EXISTS validator_registry (
        validator_id String,
        node_id String,
        auth_address String DEFAULT '',
        epoch UInt32,
        precompile_validator_id String DEFAULT '',

        stake UInt64,
        position UInt16,
        is_active UInt8 DEFAULT 1,
        is_staking_active UInt8 DEFAULT 0,
        real_time_stake_wei String DEFAULT '0',
        commission String DEFAULT '0',
        consensus_commission String DEFAULT '0',
        snapshot_commission String DEFAULT '0',

        dns_address String DEFAULT '',
        dns_host String DEFAULT '',
        dns_port UInt16 DEFAULT 8000,

        validator_name LowCardinality(String) DEFAULT 'unknown',

        keybase_id LowCardinality(String) DEFAULT '',
        keybase_logo_url String DEFAULT '',

        provider LowCardinality(String) DEFAULT 'unknown',
        location LowCardinality(String) DEFAULT 'unknown',
        country LowCardinality(String) DEFAULT 'unknown',
        datacenter LowCardinality(String) DEFAULT 'unknown',

        first_seen DateTime64(3, 'UTC') DEFAULT now(),
        last_updated DateTime64(3, 'UTC') DEFAULT now(),

        INDEX idx_precompile_validator_id precompile_validator_id TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_is_staking_active is_staking_active TYPE set(2) GRANULARITY 1
      ) ENGINE = ReplacingMergeTree(last_updated)
      PARTITION BY epoch
      ORDER BY (validator_id, epoch)
      SETTINGS index_granularity = 8192`,

      `CREATE TABLE IF NOT EXISTS validator_registry_latest (
        validator_id String,
        node_id String,
        auth_address String DEFAULT '',
        epoch UInt32,
        precompile_validator_id String DEFAULT '',

        stake UInt64,
        position UInt16,
        is_active UInt8 DEFAULT 1,
        is_staking_active UInt8 DEFAULT 0,
        real_time_stake_wei String DEFAULT '0',
        commission String DEFAULT '0',
        consensus_commission String DEFAULT '0',
        snapshot_commission String DEFAULT '0',

        dns_address String DEFAULT '',
        dns_host String DEFAULT '',
        dns_port UInt16 DEFAULT 8000,

        validator_name LowCardinality(String) DEFAULT 'unknown',
        validator_website String DEFAULT '',
        validator_logo_url String DEFAULT '',
        validator_description String DEFAULT '',
        validator_x_handle String DEFAULT '',

        keybase_id LowCardinality(String) DEFAULT '',
        keybase_logo_url String DEFAULT '',

        provider LowCardinality(String) DEFAULT 'unknown',
        location LowCardinality(String) DEFAULT 'unknown',
        country LowCardinality(String) DEFAULT 'unknown',
        datacenter LowCardinality(String) DEFAULT 'unknown',

        first_seen DateTime64(3, 'UTC') DEFAULT now(),
        last_updated DateTime64(3, 'UTC') DEFAULT now()
      ) ENGINE = ReplacingMergeTree(last_updated)
      ORDER BY (validator_id)
      SETTINGS index_granularity = 8192`,

      `CREATE MATERIALIZED VIEW IF NOT EXISTS validator_registry_latest_mv
      TO validator_registry_latest
      AS
      SELECT
        validator_id,
        node_id,
        tupleElement(latest_record, 1) AS auth_address,
        tupleElement(latest_record, 2) AS epoch,
        tupleElement(latest_record, 3) AS precompile_validator_id,
        tupleElement(latest_record, 4) AS stake,
        tupleElement(latest_record, 5) AS position,
        tupleElement(latest_record, 6) AS is_active,
        tupleElement(latest_record, 7) AS is_staking_active,
        tupleElement(latest_record, 8) AS real_time_stake_wei,
        tupleElement(latest_record, 9) AS commission,
        tupleElement(latest_record, 10) AS consensus_commission,
        tupleElement(latest_record, 11) AS snapshot_commission,
        tupleElement(latest_record, 12) AS dns_address,
        tupleElement(latest_record, 13) AS dns_host,
        tupleElement(latest_record, 14) AS dns_port,
        tupleElement(latest_record, 15) AS validator_name,
        tupleElement(latest_record, 16) AS validator_website,
        tupleElement(latest_record, 17) AS validator_logo_url,
        tupleElement(latest_record, 18) AS validator_description,
        tupleElement(latest_record, 19) AS validator_x_handle,
        tupleElement(latest_record, 20) AS keybase_id,
        tupleElement(latest_record, 21) AS keybase_logo_url,
        tupleElement(latest_record, 22) AS provider,
        tupleElement(latest_record, 23) AS location,
        tupleElement(latest_record, 24) AS country,
        tupleElement(latest_record, 25) AS datacenter,
        tupleElement(latest_record, 26) AS first_seen,
        tupleElement(latest_record, 27) AS last_updated
      FROM (
        SELECT
          validator_id,
          node_id,
          argMax((
            auth_address,
            epoch,
            precompile_validator_id,
            stake,
            position,
            is_active,
            is_staking_active,
            real_time_stake_wei,
            commission,
            consensus_commission,
            snapshot_commission,
            dns_address,
            dns_host,
            dns_port,
            validator_name,
            validator_website,
            validator_logo_url,
            validator_description,
            validator_x_handle,
            keybase_id,
            keybase_logo_url,
            provider,
            location,
            country,
            datacenter,
            first_seen,
            last_updated
          ), last_updated) AS latest_record
        FROM validator_registry
        WHERE is_active = 1
        GROUP BY validator_id, node_id
      )`,

      // =============================================
      // BFT CONSENSUS TRACKING TABLES
      // =============================================

      `CREATE TABLE IF NOT EXISTS bft_votes (
        ts DateTime64(3, 'UTC'),
        epoch UInt64,
        round UInt64,
        author FixedString(66),
        sig String,
        vote_id String,
        event_id FixedString(40),
        INDEX idx_event_id event_id TYPE bloom_filter GRANULARITY 1
      ) ENGINE = ReplacingMergeTree(ts)
      ORDER BY (epoch, round, author)
      TTL toDateTime(ts) + INTERVAL 7 DAY`,

      `CREATE TABLE IF NOT EXISTS bft_round_state (
        ts DateTime64(3, 'UTC'),
        epoch UInt64,
        round UInt64,
        current_stake UInt128,
        total_stake UInt128,
        stake_ratio Float64,
        event_id FixedString(40),
        INDEX idx_event_id event_id TYPE bloom_filter GRANULARITY 1
      ) ENGINE = ReplacingMergeTree(ts)
      ORDER BY (epoch, round)
      TTL toDateTime(ts) + INTERVAL 7 DAY`
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
  // NEW FOCUSED INSERTION METHODS
  // =============================================

  async insertBlockProposals(events: BlockProposalEvent[]): Promise<void> {
    if (events.length === 0) return;

    const data = events.map(event => ({
      timestamp: this.formatTimestamp(event.timestamp),
      validator_id: event.validatorId,
      seq_num: event.seqNum,
      round: event.roundNumber,
      epoch: event.epochNumber,
      status: event.status,
      num_tx: event.numTx,
      block_id: event.blockId || null,
      ingestion_id: event.ingestionId
    }));

    try {
      await this.client.insert({
        table: 'block_proposals',
        values: data,
        format: 'JSONEachRow'
      });
      console.log(`💾 Successfully inserted ${data.length} block proposal events`);
    } catch (error) {
      console.error('Failed to insert block proposals:', error);
      throw error;
    }
  }

  async insertQCParticipations(events: QCParticipationEvent[]): Promise<void> {
    if (events.length === 0) return;

    const data = events.map(event => ({
      timestamp: this.formatTimestamp(event.timestamp),
      seq_num: event.seqNum,
      round: event.roundNumber,
      epoch: event.epochNumber,
      validator_id: event.validatorId,
      validator_index: event.validatorIndex,
      participated: event.participated ? 1 : 0,
      qc_id: event.qcId,
      total_validators: event.totalValidators,
      participating_validators: event.participatingValidators,
      participation_rate: event.participationRate,
      ingestion_id: event.ingestionId
    }));

    try {
      await this.client.insert({
        table: 'qc_participation',
        values: data,
        format: 'JSONEachRow'
      });
      console.log(`💾 Successfully inserted ${data.length} QC participation events`);
    } catch (error) {
      console.error('Failed to insert QC participations:', error);
      throw error;
    }
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

    const result = await this.executeRawQuery(query);

    return result;
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

    const result = await this.executeRawQuery(query);

    const rows = await result;
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

    const result = await this.executeRawQuery(query);

    return result;
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

    const result = await this.executeRawQuery(query);

    return result;
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

    const result = await this.executeRawQuery(query);

    return result;
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

    const result = await this.executeRawQuery(query);

    return result;
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

  async insertRows(table: string, rows: any[]): Promise<void> {
    if (!rows || rows.length === 0) {
      return;
    }

    await this.client.insert({
      table,
      values: rows,
      format: 'JSONEachRow'
    });
  }

  // =============================================
  // STAKING EVENTS INSERTION METHODS
  // =============================================

  /**
   * Insert staking events into database
   */
  async insertStakingEvents(events: import('../services/staking-events/types').StakingEventRecord[]): Promise<void> {
    if (events.length === 0) return;

    try {
      await this.client.insert({
        table: 'staking_events',
        values: events,
        format: 'JSONEachRow'
      });
      logger.info(`💾 Successfully inserted ${events.length} staking events`);
    } catch (error) {
      logger.error('Failed to insert staking events:', error);
      throw error;
    }
  }

  /**
   * Insert or update validator delegation records
   */
  async upsertValidatorDelegations(delegations: import('../services/staking-events/types').ValidatorDelegationRecord[]): Promise<void> {
    if (delegations.length === 0) return;

    try {
      await this.client.insert({
        table: 'validator_delegations',
        values: delegations,
        format: 'JSONEachRow'
      });
      logger.info(`💾 Successfully upserted ${delegations.length} validator delegation records`);
    } catch (error) {
      logger.error('Failed to upsert validator delegations:', error);
      throw error;
    }
  }

  /**
   * Insert delegation history records
   */
  async insertDelegationHistory(history: import('../services/staking-events/types').DelegationHistoryRecord[]): Promise<void> {
    if (history.length === 0) return;

    try {
      await this.client.insert({
        table: 'delegation_history',
        values: history,
        format: 'JSONEachRow'
      });
      logger.info(`💾 Successfully inserted ${history.length} delegation history records`);
    } catch (error) {
      logger.error('Failed to insert delegation history:', error);
      throw error;
    }
  }

  /**
   * Insert reward event records
   */
  async insertRewardEvents(rewards: import('../services/staking-events/types').RewardEventRecord[]): Promise<void> {
    if (rewards.length === 0) return;

    try {
      await this.client.insert({
        table: 'reward_events',
        values: rewards,
        format: 'JSONEachRow'
      });
      logger.info(`💾 Successfully inserted ${rewards.length} reward events`);
    } catch (error) {
      logger.error('Failed to insert reward events:', error);
      throw error;
    }
  }

  /**
   * Check if a staking event has already been processed (deduplication)
   */
  async isStakingEventProcessed(eventId: string): Promise<boolean> {
    try {
      const query = `
        SELECT count() as count
        FROM staking_events
        WHERE event_id = '${eventId}'
        LIMIT 1
      `;
      const result = await this.executeRawQuery(query);
      return Number(result[0]?.count || 0) > 0;
    } catch (error) {
      logger.error('Failed to check if staking event is processed:', error);
      return false;
    }
  }

  /**
   * Get current delegation state for a validator-delegator pair
   */
  async getValidatorDelegation(validatorId: string, delegator: string): Promise<import('../services/staking-events/types').ValidatorDelegationRecord | null> {
    try {
      const query = `
        SELECT *
        FROM validator_delegations
        WHERE validator_id = '${validatorId}'
          AND delegator = '${delegator}'
        ORDER BY last_updated_at DESC
        LIMIT 1
      `;
      const result = await this.executeRawQuery(query);
      return result.length > 0 ? result[0] : null;
    } catch (error) {
      logger.error('Failed to get validator delegation:', error);
      return null;
    }
  }

  /**
   * Ensure validator_registry tables support auth_address column.
   * Safe to call multiple times; heavy operations only occur when column is missing or view definition is outdated.
   */
  async ensureValidatorRegistryAuthColumns(): Promise<void> {
    if (this.authAddressColumnEnsured) {
      return;
    }

    const database = this.getDatabaseName();

    try {
      const ensureColumn = async (
        table: string,
        columnName: string,
        definition: string,
        description: string
      ): Promise<void> => {
        const result = await this.executeRawQuery(`
          SELECT count() AS count
          FROM system.columns
          WHERE database = '${database}'
            AND table = '${table}'
            AND name = '${columnName}'
        `);

        const hasColumn = Number(result[0]?.count || 0) > 0;

        if (!hasColumn) {
          logger.info(`🔧 Adding ${description} column to ${table}...`);
          await this.executeCommand(`ALTER TABLE ${database}.${table} ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`);
        }
      };

      await ensureColumn('validator_registry', 'auth_address', "String DEFAULT '' AFTER node_id", 'auth_address');
      await ensureColumn('validator_registry', 'commission', "String DEFAULT '0' AFTER real_time_stake_wei", 'commission');
      await ensureColumn('validator_registry', 'consensus_commission', "String DEFAULT '0'", 'consensus_commission');
      await ensureColumn('validator_registry', 'snapshot_commission', "String DEFAULT '0'", 'snapshot_commission');

      // Ensure latest snapshot table and materialized view are updated if they exist
      const latestTableResult = await this.executeRawQuery(`
        SELECT count() AS count
        FROM system.tables
        WHERE database = '${database}'
          AND name = 'validator_registry_latest'
      `);

      const hasLatestTable = Number(latestTableResult[0]?.count || 0) > 0;

      if (hasLatestTable) {
        await ensureColumn('validator_registry_latest', 'auth_address', "String DEFAULT '' AFTER validator_id", 'auth_address');
        await ensureColumn('validator_registry_latest', 'commission', "String DEFAULT '0' AFTER real_time_stake_wei", 'commission');
        await ensureColumn('validator_registry_latest', 'consensus_commission', "String DEFAULT '0'", 'consensus_commission');
        await ensureColumn('validator_registry_latest', 'snapshot_commission', "String DEFAULT '0'", 'snapshot_commission');

        // Determine if materialized view needs to be rebuilt (missing or outdated definition)
        const mvInfo = await this.executeRawQuery(`
          SELECT create_table_query
          FROM system.tables
          WHERE database = '${database}'
            AND name = 'validator_registry_latest_mv'
            AND engine = 'MaterializedView'
        `);

        const mvDefinition = mvInfo[0]?.create_table_query as string | undefined;
        const mvNeedsRebuild = !mvDefinition
          || !['auth_address', 'commission', 'consensus_commission', 'snapshot_commission']
            .every(token => mvDefinition.toLowerCase().includes(token));

        if (mvNeedsRebuild) {
          logger.info('🔄 Rebuilding validator_registry_latest materialized view to include latest staking columns...');
          await this.executeCommand(`DROP VIEW IF EXISTS ${database}.validator_registry_latest_mv`);
          await this.executeCommand(`TRUNCATE TABLE ${database}.validator_registry_latest`);
          await this.executeCommand(`
CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.validator_registry_latest_mv
TO ${database}.validator_registry_latest
AS
SELECT
    validator_id,
    tupleElement(latest_record, 1) AS auth_address,
    tupleElement(latest_record, 2) AS validator_name,
    tupleElement(latest_record, 3) AS provider,
    tupleElement(latest_record, 4) AS location,
    tupleElement(latest_record, 5) AS country,
    tupleElement(latest_record, 6) AS datacenter,
    tupleElement(latest_record, 7) AS stake,
    tupleElement(latest_record, 8) AS real_time_stake_wei,
    tupleElement(latest_record, 9) AS commission,
    tupleElement(latest_record, 10) AS consensus_commission,
    tupleElement(latest_record, 11) AS snapshot_commission,
    tupleElement(latest_record, 12) AS keybase_id,
    tupleElement(latest_record, 13) AS keybase_logo_url,
    tupleElement(latest_record, 14) AS last_updated
FROM (
    SELECT
        validator_id,
        argMax((
          auth_address,
          validator_name,
          provider,
          location,
          country,
          datacenter,
          stake,
          real_time_stake_wei,
          commission,
          consensus_commission,
          snapshot_commission,
          keybase_id,
          keybase_logo_url,
          last_updated
        ), last_updated) AS latest_record
    FROM ${database}.validator_registry
    WHERE is_active = 1
    GROUP BY validator_id
)
POPULATE
          `);
        }
      }

      this.authAddressColumnEnsured = true;
    } catch (error) {
      logger.error('Failed to ensure auth_address column in validator registry tables:', error);
      throw error;
    }
  }

  private buildValidatorRegistryLatestSelect(filter?: string): string {
    const database = this.getDatabaseName();
    const additionalFilter = filter ? `AND ${filter}` : '';
    return `
      WITH ranked_validators AS (
        SELECT
          validator_id,
          node_id,
          auth_address,
          epoch,
          precompile_validator_id,
          stake,
          position,
          is_active,
          is_staking_active,
          real_time_stake_wei,
          commission,
          consensus_commission,
          snapshot_commission,
          dns_address,
          dns_host,
          dns_port,
          validator_name,
          keybase_id,
          keybase_logo_url,
          provider,
          location,
          country,
          datacenter,
          first_seen,
          last_updated,
          ROW_NUMBER() OVER (PARTITION BY validator_id ORDER BY last_updated DESC) AS rn
        FROM ${database}.validator_registry FINAL
        WHERE is_active = 1
        ${additionalFilter}
      )
      SELECT
        validator_id,
        node_id,
        auth_address,
        epoch,
        precompile_validator_id,
        stake,
        position,
        is_active,
        is_staking_active,
        real_time_stake_wei,
        commission,
        consensus_commission,
        snapshot_commission,
        dns_address,
        dns_host,
        dns_port,
        validator_name,
        keybase_id,
        keybase_logo_url,
        provider,
        location,
        country,
        datacenter,
        first_seen,
        last_updated
      FROM ranked_validators
      WHERE rn = 1
    `;
  }

  private buildValidatorIdList(validatorIds: string[]): string {
    return validatorIds
      .map(id => `'${id.replace(/'/g, "''")}'`)
      .join(', ');
  }

  async rebuildValidatorRegistryLatest(validatorIds?: string[]): Promise<void> {
    // Use mutex to prevent race conditions during concurrent rebuilds
    return this.rebuildMutex.runExclusive(async () => {
      const database = this.getDatabaseName();

      if (validatorIds && validatorIds.length === 0) {
        return;
      }

      const uniqueValidatorIds = validatorIds && validatorIds.length > 0
        ? Array.from(new Set(validatorIds))
        : undefined;

      const filter = uniqueValidatorIds && uniqueValidatorIds.length > 0
        ? `validator_id IN (${this.buildValidatorIdList(uniqueValidatorIds)})`
        : undefined;

      try {
        if (!uniqueValidatorIds || uniqueValidatorIds.length === 0) {
          await this.executeCommand(`TRUNCATE TABLE ${database}.validator_registry_latest`);
        } else {
          await this.executeCommand(`ALTER TABLE ${database}.validator_registry_latest DELETE WHERE validator_id IN (${this.buildValidatorIdList(uniqueValidatorIds)}) SETTINGS mutations_sync = 2`);
        }

        const selectQuery = this.buildValidatorRegistryLatestSelect(filter);
        const columnList = [
          'validator_id',
          'node_id',
          'auth_address',
          'epoch',
          'precompile_validator_id',
          'stake',
          'position',
          'is_active',
          'is_staking_active',
          'real_time_stake_wei',
          'commission',
          'consensus_commission',
          'snapshot_commission',
          'dns_address',
          'dns_host',
          'dns_port',
          'validator_name',
          'keybase_id',
          'keybase_logo_url',
          'provider',
          'location',
          'country',
          'datacenter',
          'first_seen',
          'last_updated'
        ].join(', ');

        await this.executeCommand(
          `INSERT INTO ${database}.validator_registry_latest (${columnList}) ${selectQuery}`
        );
      } catch (error) {
        logger.error('Failed to rebuild validator_registry_latest snapshot:', error);
        throw error;
      }
    });
  }

  // =============================================
  // VALIDATOR REGISTRY SYNC
  // =============================================
  
  /**
   * Updates the validator_registry table with the latest validator data.
   * This method only creates new entries when validator metadata has actually changed,
   * preventing unnecessary duplicates while preserving existing keybase data.
   * @param validators The list of complete validator objects to insert.
   */
  async updateValidatorRegistry(validators: CompleteValidator[]): Promise<void> {
    if (validators.length === 0) {
      logger.warn('Validator list is empty, skipping registry update.');
      return;
    }

    await this.ensureValidatorRegistryAuthColumns();

    const tableName = 'validator_registry';
    logger.info(`🚀 Starting smart sync for ${tableName} with ${validators.length} validators...`);

    try {
      // Step 1: Get existing keybase mappings to preserve them
      logger.info(`Preserving existing keybase mappings...`);
      const existingKeybaseQuery = `
        SELECT validator_id, keybase_id, keybase_logo_url
        FROM ${tableName}
        WHERE keybase_id != '' AND keybase_id IS NOT NULL
      `;
      const existingKeybaseData = await this.executeRawQuery(existingKeybaseQuery);
      const keybaseMap = new Map<string, { keybase_id: string; keybase_logo_url: string }>();
      
      existingKeybaseData.forEach(row => {
        keybaseMap.set(row.validator_id, {
          keybase_id: row.keybase_id,
          keybase_logo_url: row.keybase_logo_url
        });
      });
      logger.info(`✅ Preserved ${keybaseMap.size} keybase mappings`);

      // Step 2: Get latest existing data for each validator to compare against
      logger.info(`Fetching latest validator data for comparison...`);
      const latestDataQuery = `
        SELECT 
          validator_id,
          auth_address,
          stake,
          position,
          is_active,
          dns_address,
          dns_host,
          dns_port,
          validator_name,
          provider,
          location,
          country,
          datacenter,
          real_time_stake_wei,
          commission,
          consensus_commission,
          snapshot_commission
        FROM (
          SELECT *,
                 ROW_NUMBER() OVER (PARTITION BY validator_id ORDER BY last_updated DESC) as rn
          FROM ${tableName}
        )
        WHERE rn = 1
      `;
      const existingData = await this.executeRawQuery(latestDataQuery);
      const existingMap = new Map<string, any>();
      
      existingData.forEach(row => {
        existingMap.set(row.validator_id, row);
      });
      logger.info(`✅ Retrieved latest data for ${existingData.length} existing validators`);

      // Step 3: Compare new data against existing and identify changes
      const validatorsToUpdate: any[] = [];
      let unchangedCount = 0;

      const preserveNumericString = (value: any): string => {
        if (value === null || value === undefined) {
          return '0';
        }
        if (typeof value === 'string') {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : '0';
        }
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) {
            return '0';
          }
          // Use toFixed(0) to prevent scientific notation for very large numbers
          return value.toFixed(0);
        }
        if (typeof value === 'bigint') {
          return value.toString();
        }
        return '0';
      };

      for (const v of validators) {
        const existingKeybase = keybaseMap.get(v.nodeId);
        const existing = existingMap.get(v.nodeId);
        const newRecord = {
          validator_id: v.nodeId,
          node_id: v.nodeId,
          epoch: v.epoch,
          stake: preserveNumericString(v.stake),
          position: v.position,
          is_active: v.isActive ? 1 : 0,
          real_time_stake_wei: preserveNumericString(existing?.real_time_stake_wei),
          commission: preserveNumericString(existing?.commission),
          consensus_commission: preserveNumericString(existing?.consensus_commission),
          snapshot_commission: preserveNumericString(existing?.snapshot_commission),
          auth_address: existing?.auth_address || '',
          dns_address: v.location?.dnsAddress || '',
          dns_host: v.location?.hostname || '',
          dns_port: v.location?.port || 8000,
          validator_name: v.location?.validatorName || 'unknown',
          provider: v.location?.organization || 'unknown',
          location: v.location?.city ? `${v.location.city}, ${v.location.country}` : v.location?.country || 'unknown',
          country: v.location?.country || 'unknown',
          datacenter: v.location?.isp || 'unknown',
          keybase_id: existingKeybase?.keybase_id || '',
          keybase_logo_url: existingKeybase?.keybase_logo_url || '',
          first_seen: v.lastUpdated.toISOString().slice(0, 19).replace('T', ' '),
          last_updated: v.lastUpdated.toISOString().slice(0, 19).replace('T', ' '),
        };
      
        // Check if this is a new validator or if metadata has changed
        if (!existing || this.hasValidatorDataChanged(existing, newRecord)) {
          validatorsToUpdate.push(newRecord);
        } else {
          unchangedCount++;
        }
      }

      logger.info(`📊 Analysis complete: ${validatorsToUpdate.length} validators need updates, ${unchangedCount} unchanged`);

      // Step 4: Only insert validators that have actually changed
      if (validatorsToUpdate.length > 0) {
        logger.info(`Inserting ${validatorsToUpdate.length} changed validators into ${tableName}...`);
        
        await this.client.insert({
          table: tableName,
          values: validatorsToUpdate,
          format: 'JSONEachRow',
        });

        // Step 5: Optimize table to merge duplicates
        logger.info(`Optimizing table to merge duplicates...`);
        await this.client.command({
          query: `OPTIMIZE TABLE ${tableName} FINAL`,
          clickhouse_settings: {
            wait_end_of_query: 1,
          },
        });

        await this.rebuildValidatorRegistryLatest(
          validatorsToUpdate.map(v => v.validator_id)
        );

        logger.info(`✅ Successfully updated ${validatorsToUpdate.length} validators in ${tableName} (preserved ${keybaseMap.size} keybase mappings, skipped ${unchangedCount} unchanged).`);
      } else {
        logger.info(`✅ No validator updates needed - all ${validators.length} validators are up to date (preserved ${keybaseMap.size} keybase mappings).`);
      }

    } catch (error) {
      logger.error(`❌ Failed to sync ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Determines if validator data has meaningfully changed
   * @param existing The existing validator record from database
   * @param newRecord The new validator record to be inserted
   * @returns true if the data has changed and requires an update
   */
  private hasValidatorDataChanged(existing: any, newRecord: any): boolean {
    // Compare all meaningful fields (excluding epoch, timestamps, and keybase which is preserved separately)
    const fieldsToCompare = [
      'stake', 'position', 'is_active', 'auth_address', 'dns_address', 'dns_host', 'dns_port',
      'validator_name', 'provider', 'location', 'country', 'datacenter'
    ];

    for (const field of fieldsToCompare) {
      // Handle null/undefined/empty string normalization
      const existingValue = this.normalizeValue(existing[field]);
      const newValue = this.normalizeValue(newRecord[field]);
      
      if (existingValue !== newValue) {
        return true;
      }
    }

    return false;
  }

  /**
   * Normalizes values for comparison (handles null, undefined, empty strings)
   */
  private normalizeValue(value: any): string {
    if (value === null || value === undefined || value === '') {
      return 'unknown';
    }
    return String(value).trim();
  }
}
