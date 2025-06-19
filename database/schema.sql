-- Monad Validator Analytics - Enhanced ClickHouse Schema
-- Based on comprehensive Phase 1 log analysis
-- Supports 15+ event types, QC participation, vote chains, geographic intelligence

-- =============================================
-- 1. RAW LOGS STORAGE
-- =============================================

CREATE DATABASE IF NOT EXISTS monad_analytics;
USE monad_analytics;

-- Raw logs table with enhanced compression and deduplication
CREATE TABLE raw_logs (
    timestamp DateTime64(3, 'UTC'),
    log_source Enum8('consensus' = 1, 'ledger_tail' = 2),
    log_level Enum8('DEBUG' = 1, 'INFO' = 2, 'WARN' = 3, 'ERROR' = 4),
    log_target String,
    raw_content String CODEC(ZSTD(1)),
    parsed_at DateTime64(3, 'UTC') DEFAULT now(),
    ingestion_id UUID DEFAULT generateUUIDv4(),
    
    -- Parsing status tracking
    parsing_status Enum8('pending' = 1, 'success' = 2, 'failed' = 3, 'partial' = 4) DEFAULT 'pending',
    parsing_error Nullable(String)
) ENGINE = ReplacingMergeTree(parsed_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, log_source, ingestion_id)
TTL toDateTime(timestamp) + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;

-- =============================================
-- 2. ENHANCED VALIDATOR EVENTS
-- =============================================

-- Main validator events table with comprehensive event type coverage
CREATE TABLE validator_events (
    timestamp DateTime64(3, 'UTC'),
    event_type Enum16(
        -- Consensus events (1-10)
        'vote_attempt' = 1, 'vote_result' = 2, 'vote_created' = 3,
        'proposal_received' = 4, 'proposal_detailed' = 5, 'proposal_validated' = 6,
        'qc_commit_attempt' = 7, 'qc_commit_triggered' = 8,
        
        -- Block events (10-20)
        'block_proposal' = 10, 'block_committed' = 11, 'block_skipped' = 12,
        'block_sequence_committed' = 13,
        
        -- Transaction events (20-30)
        'txpool_updated' = 20,
        
        -- System events (30-40)
        'telemetry_export' = 30, 'metrics_collected' = 31
    ),
    
    -- Core identifiers
    validator_id String,
    round_number UInt64,
    epoch_number UInt32,
    block_number Nullable(UInt64),
    block_id Nullable(String),
    
    -- Vote chain relationships (NEW - from Phase 1 analysis)
    parent_vote_id Nullable(String),
    parent_round Nullable(UInt64), 
    next_leader_id Nullable(String),
    
    -- Enhanced timing data with nanosecond precision
    block_timestamp_ms Nullable(UInt64),
    processing_timestamp_ms UInt64,
    processing_delay_ms UInt32,
    
    -- Proposal metadata (NEW)
    transaction_count UInt32 DEFAULT 0,
    state_root_action LowCardinality(String), -- 'Proceed', etc.
    sequence_number Nullable(UInt64),
    
    -- Geographic and infrastructure intelligence (ENHANCED)
    validator_dns String,
    geographic_region LowCardinality(String), -- Extracted from DNS
    infrastructure_provider LowCardinality(String), -- Extracted from DNS
    datacenter_code LowCardinality(String), -- e.g., 'tsw-sgp-004'
    
    -- Performance metrics
    is_successful UInt8 DEFAULT 1,
    participant_count Nullable(UInt16), -- For QC events
    participation_rate Nullable(Float32), -- For QC events
    
    -- Raw metadata for complex structures
    metadata String CODEC(ZSTD(1)),
    
    -- Processing metadata
    ingestion_id UUID,
    processed_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, validator_id, event_type, round_number)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- Performance indexes for common query patterns
ALTER TABLE validator_events ADD INDEX idx_round_validator (round_number, validator_id) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_events ADD INDEX idx_geographic (geographic_region, timestamp) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_events ADD INDEX idx_provider (infrastructure_provider, timestamp) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_events ADD INDEX idx_event_success (event_type, is_successful) TYPE minmax GRANULARITY 1;

-- =============================================
-- 3. QC PARTICIPATION TRACKING (NEW)
-- =============================================

-- Dedicated table for Quorum Certificate participation analysis
CREATE TABLE qc_participation (
    timestamp DateTime64(3, 'UTC'),
    round_number UInt64,
    qc_vote_id String,
    epoch_number UInt32,
    
    -- Participation metrics
    total_validators UInt16,
    participating_validators UInt16,
    participation_bitmap String, -- BitVec as string for analysis
    participation_rate Float32,
    
    -- Cryptographic data
    bls_signature String,
    signature_verification_time_ns Nullable(UInt64),
    qc_assembly_time_ms UInt32,
    
    -- Individual validator participation (Array for detailed analysis)
    validator_participation Array(Tuple(String, UInt8)), -- (validator_id, participated: 0/1)
    
    -- Performance metrics
    consensus_latency_ms UInt32,
    block_id String,
    proposer_id String,
    
    -- Processing metadata
    processed_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, round_number)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Indexes for QC analysis
ALTER TABLE qc_participation ADD INDEX idx_participation_rate (participation_rate) TYPE minmax GRANULARITY 1;
ALTER TABLE qc_participation ADD INDEX idx_round_epoch (round_number, epoch_number) TYPE minmax GRANULARITY 1;

-- =============================================
-- 4. ENHANCED VALIDATOR REGISTRY
-- =============================================

-- Comprehensive validator registry with infrastructure intelligence
CREATE TABLE validators (
    validator_id String,
    short_id String MATERIALIZED substring(validator_id, 1, 12),
    
    -- Infrastructure details (ENHANCED based on DNS analysis)
    dns_name String,
    geographic_region LowCardinality(String),
    datacenter_location LowCardinality(String), -- 'Singapore-004', 'JFK-013'
    infrastructure_provider LowCardinality(String),
    provider_type Enum8('monadinfra' = 1, 'community' = 2, 'enterprise' = 3),
    
    -- Network information
    endpoint_host String,
    endpoint_port UInt16 DEFAULT 8000,
    
    -- Performance classification
    validator_tier Enum8('tier1' = 1, 'tier2' = 2, 'tier3' = 3) DEFAULT 1,
    
    -- Operational data
    first_seen DateTime64(3, 'UTC'),
    last_active DateTime64(3, 'UTC'),
    is_active UInt8 DEFAULT 1,
    activity_score Float32 DEFAULT 100.0,
    
    -- Performance aggregates (updated via materialized views)
    total_proposals UInt64 DEFAULT 0,
    successful_proposals UInt64 DEFAULT 0,
    total_votes UInt64 DEFAULT 0,
    successful_votes UInt64 DEFAULT 0,
    avg_response_latency_ms Float32 DEFAULT 0,
    
    -- Versioning for updates
    updated_at DateTime64(3, 'UTC') DEFAULT now(),
    version UInt64 DEFAULT 1
) ENGINE = ReplacingMergeTree(version)
ORDER BY validator_id
SETTINGS index_granularity = 8192;

-- =============================================
-- 4A. VALIDATOR INFO CACHE TABLE (NEW)
-- =============================================

-- Pre-processed validator information for high-performance lookups
CREATE TABLE validator_info_cache (
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
TTL toDateTime(updated_at) + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;

-- Index for fast validator lookups
ALTER TABLE validator_info_cache ADD INDEX idx_node_epoch (node_id, epoch) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_info_cache ADD INDEX idx_provider (provider, updated_at) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_info_cache ADD INDEX idx_location (country, city) TYPE minmax GRANULARITY 1;

-- =============================================
-- 5. PRE-AGGREGATED PERFORMANCE TABLES
-- =============================================

-- Real-time validator performance aggregations
CREATE TABLE validator_performance_agg (
    timestamp DateTime,
    time_window Enum8('1m' = 1, '5m' = 2, '1h' = 3, '24h' = 4),
    validator_id String,
    
    -- Block performance
    blocks_proposed AggregateFunction(count, UInt8),
    blocks_committed AggregateFunction(count, UInt8), 
    blocks_skipped AggregateFunction(count, UInt8),
    avg_proposal_delay AggregateFunction(avg, UInt32),
    
    -- Voting performance  
    votes_attempted AggregateFunction(count, UInt8),
    votes_successful AggregateFunction(count, UInt8),
    avg_vote_latency AggregateFunction(avg, UInt32),
    
    -- QC participation
    qc_participations AggregateFunction(count, UInt8),
    avg_qc_participation_rate AggregateFunction(avg, Float32),
    
    -- Leadership metrics
    leadership_rounds AggregateFunction(count, UInt8),
    avg_leadership_latency AggregateFunction(avg, UInt32)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, time_window, validator_id)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Network-wide aggregations
CREATE TABLE network_metrics_agg (
    timestamp DateTime,
    time_window Enum8('1m' = 1, '5m' = 2, '1h' = 3, '24h' = 4),
    
    -- Consensus metrics
    total_rounds AggregateFunction(uniq, UInt64),
    successful_rounds AggregateFunction(count, UInt8),
    avg_round_time AggregateFunction(avg, UInt32),
    avg_qc_participation_rate AggregateFunction(avg, Float32),
    
    -- Block metrics
    total_blocks AggregateFunction(count, UInt8),
    avg_block_time AggregateFunction(avg, UInt32), 
    avg_processing_delay AggregateFunction(avg, UInt32),
    
    -- Validator metrics
    active_validators AggregateFunction(uniq, String),
    active_regions AggregateFunction(uniq, String),
    active_providers AggregateFunction(uniq, String),
    
    -- Performance indicators
    consensus_efficiency AggregateFunction(avg, Float32),
    network_latency_p95 AggregateFunction(quantile(0.95), UInt32)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, time_window)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- =============================================
-- 6. GEOGRAPHIC INTELLIGENCE TABLES
-- =============================================

-- Geographic performance tracking
CREATE TABLE geographic_metrics (
    timestamp DateTime,
    time_window Enum8('1m' = 1, '5m' = 2, '1h' = 3, '24h' = 4),
    geographic_region LowCardinality(String),
    
    -- Validator metrics
    active_validators AggregateFunction(uniq, String),
    infrastructure_providers AggregateFunction(uniq, String),
    
    -- Performance metrics
    total_proposals AggregateFunction(count, UInt8),
    successful_commits AggregateFunction(count, UInt8),
    avg_latency AggregateFunction(avg, UInt32),
    
    -- Network contribution
    qc_participation_rate AggregateFunction(avg, Float32),
    leadership_assignments AggregateFunction(count, UInt8),
    
    -- Risk metrics
    validator_concentration AggregateFunction(max, Float32),
    provider_diversity AggregateFunction(uniq, String)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, time_window, geographic_region)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- =============================================
-- 7. PERFORMANCE PROJECTIONS
-- =============================================

-- Projection for validator ranking queries (most common)
ALTER TABLE validator_events ADD PROJECTION validator_ranking_proj (
    SELECT 
        validator_id, 
        event_type, 
        is_successful, 
        processing_delay_ms, 
        timestamp,
        geographic_region
    ORDER BY validator_id, timestamp
);

-- Projection for time-series analysis
ALTER TABLE validator_events ADD PROJECTION timeseries_proj (
    SELECT 
        timestamp, 
        event_type, 
        round_number, 
        processing_delay_ms,
        participation_rate
    ORDER BY timestamp, event_type
);

-- =============================================
-- 8. INDEXES FOR COMPLEX QUERIES
-- =============================================

-- Additional specialized indexes
ALTER TABLE validator_events ADD INDEX idx_round_time (round_number, timestamp) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_events ADD INDEX idx_block_validator (block_number, validator_id) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_events ADD INDEX idx_latency (processing_delay_ms) TYPE minmax GRANULARITY 1;

-- QC participation indexes
ALTER TABLE qc_participation ADD INDEX idx_proposer_time (proposer_id, timestamp) TYPE minmax GRANULARITY 1;
ALTER TABLE qc_participation ADD INDEX idx_consensus_latency (consensus_latency_ms) TYPE minmax GRANULARITY 1;

-- Geographic indexes
ALTER TABLE geographic_metrics ADD INDEX idx_region_time (geographic_region, timestamp) TYPE minmax GRANULARITY 1;

-- =============================================
-- 9. TABLE COMMENTS FOR DOCUMENTATION
-- =============================================

ALTER TABLE raw_logs MODIFY COMMENT 'Raw log storage with deduplication and compression';
ALTER TABLE validator_events MODIFY COMMENT 'Main events table with 15+ event types and enhanced metadata';
ALTER TABLE qc_participation MODIFY COMMENT 'QC participation tracking with BitVec analysis support';
ALTER TABLE validators MODIFY COMMENT 'Enhanced validator registry with infrastructure intelligence';
ALTER TABLE validator_performance_agg MODIFY COMMENT 'Pre-aggregated validator performance metrics';
ALTER TABLE network_metrics_agg MODIFY COMMENT 'Network-wide consensus and performance aggregations';
ALTER TABLE geographic_metrics MODIFY COMMENT 'Geographic distribution and risk analysis'; 