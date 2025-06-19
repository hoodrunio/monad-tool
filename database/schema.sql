-- Monad Validator Analytics - Refactored ClickHouse Schema
-- Focus: Separate Validator Metrics (Block Proposals + QC Participation)
-- Removes generic "validator_events" approach and focuses on actual consensus data

-- =============================================
-- 1. DATABASE SETUP
-- =============================================

CREATE DATABASE IF NOT EXISTS monad_analytics;
USE monad_analytics;

-- =============================================
-- 2. RAW LOGS STORAGE (Minimal)
-- =============================================

CREATE TABLE raw_logs (
    timestamp DateTime64(3, 'UTC'),
    log_source Enum8('consensus' = 1, 'ledger_tail' = 2),
    log_level Enum8('DEBUG' = 1, 'INFO' = 2, 'WARN' = 3, 'ERROR' = 4),
    log_target String,
    raw_content String CODEC(ZSTD(1)),
    parsed_at DateTime64(3, 'UTC') DEFAULT now(),
    
    -- Processing status
    parsing_status Enum8('pending' = 1, 'success' = 2, 'failed' = 3) DEFAULT 'pending',
    parsing_error Nullable(String)
) ENGINE = ReplacingMergeTree(parsed_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, log_source)
TTL toDateTime(timestamp) + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;

-- =============================================
-- 3. VALIDATOR REGISTRY & INFRASTRUCTURE
-- =============================================

CREATE TABLE validator_registry (
    validator_id String,
    node_id String,
    epoch UInt32,
    
    -- Validator info from registry
    stake UInt64,
    position UInt16,
    is_active UInt8 DEFAULT 1,
    
    -- DNS and infrastructure mapping
    dns_address String DEFAULT '',
    dns_host String DEFAULT '',
    dns_port UInt16 DEFAULT 8000,
    provider LowCardinality(String) DEFAULT 'unknown',
    location LowCardinality(String) DEFAULT 'unknown',
    country LowCardinality(String) DEFAULT 'unknown',
    datacenter LowCardinality(String) DEFAULT 'unknown',
    
    -- Tracking
    first_seen DateTime64(3, 'UTC') DEFAULT now(),
    last_updated DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = ReplacingMergeTree(last_updated)
PARTITION BY epoch
ORDER BY (validator_id, epoch)
SETTINGS index_granularity = 8192;

-- =============================================
-- 4. BLOCK PROPOSAL EVENTS (from ledger.json)
-- =============================================

CREATE TABLE block_proposals (
    timestamp DateTime64(3, 'UTC'),
    validator_id String,
    seq_num UInt64,
    round UInt64,
    epoch UInt64,
    
    -- Proposal status: proposed or skipped
    status Enum8('proposed' = 1, 'skipped' = 2),
    num_tx UInt32 DEFAULT 0,
    block_id Nullable(String),
    
    -- Infrastructure data (from validator registry)
    provider LowCardinality(String) DEFAULT 'unknown',
    location LowCardinality(String) DEFAULT 'unknown',
    
    -- Processing metadata
    ingestion_id UUID DEFAULT generateUUIDv4(),
    processed_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (seq_num, validator_id)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- Indexes for block proposals
ALTER TABLE block_proposals ADD INDEX idx_status (status) TYPE set(2) GRANULARITY 1;
ALTER TABLE block_proposals ADD INDEX idx_validator_time (validator_id, timestamp) TYPE minmax GRANULARITY 1;
ALTER TABLE block_proposals ADD INDEX idx_round_epoch (round, epoch) TYPE minmax GRANULARITY 1;

-- =============================================
-- 5. QC PARTICIPATION EVENTS (from monad-bft.json BitVec)
-- =============================================

CREATE TABLE qc_participation (
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
    
    -- Infrastructure data (from validator registry)
    provider LowCardinality(String) DEFAULT 'unknown',
    location LowCardinality(String) DEFAULT 'unknown',
    
    -- Processing metadata
    ingestion_id UUID DEFAULT generateUUIDv4(),
    processed_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (seq_num, validator_id)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- Indexes for QC participation
ALTER TABLE qc_participation ADD INDEX idx_participated (participated) TYPE set(2) GRANULARITY 1;
ALTER TABLE qc_participation ADD INDEX idx_validator_time (validator_id, timestamp) TYPE minmax GRANULARITY 1;
ALTER TABLE qc_participation ADD INDEX idx_round_epoch (round, epoch) TYPE minmax GRANULARITY 1;

-- =============================================
-- 6. VALIDATOR SEPARATE METRICS (Pre-aggregated)
-- =============================================

CREATE TABLE validator_metrics_hourly (
    hour DateTime,
    validator_id String,
    
    -- Metric 1: Block Proposal Ratio (when it's their turn)
    blocks_proposed UInt32 DEFAULT 0,
    blocks_skipped UInt32 DEFAULT 0,
    block_proposal_ratio Float32 DEFAULT 0,
    
    -- Metric 2: QC Participation Rate (for all blocks)
    qc_participations UInt32 DEFAULT 0,
    total_qc_opportunities UInt32 DEFAULT 0,
    qc_participation_rate Float32 DEFAULT 0,
    
    -- Metric 3: Combined Uptime Score
    uptime_score Float32 DEFAULT 0, -- 30% block proposals + 70% QC participation
    
    -- Infrastructure metadata
    provider LowCardinality(String) DEFAULT 'unknown',
    location LowCardinality(String) DEFAULT 'unknown',
    
    -- Metadata
    updated_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, validator_id)
TTL toDateTime(hour) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Indexes for metrics queries
ALTER TABLE validator_metrics_hourly ADD INDEX idx_uptime_score (uptime_score) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_metrics_hourly ADD INDEX idx_block_ratio (block_proposal_ratio) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_metrics_hourly ADD INDEX idx_qc_rate (qc_participation_rate) TYPE minmax GRANULARITY 1;
ALTER TABLE validator_metrics_hourly ADD INDEX idx_provider (provider) TYPE set(0) GRANULARITY 1;
ALTER TABLE validator_metrics_hourly ADD INDEX idx_location (location) TYPE set(0) GRANULARITY 1;

-- =============================================
-- 7. NETWORK HEALTH METRICS
-- =============================================

CREATE TABLE network_health_hourly (
    hour DateTime,
    
    -- Consensus health
    total_rounds UInt32,
    successful_rounds UInt32,
    consensus_efficiency Float32,
    avg_qc_participation Float32,
    
    -- Block production
    total_blocks UInt32,
    total_proposals UInt32,
    total_skips UInt32,
    proposal_success_rate Float32,
    
    -- Network participation
    active_validators UInt16,
    total_registered_validators UInt16,
    validator_participation_rate Float32,
    
    -- Geographic distribution
    active_locations UInt16,
    active_providers UInt16,
    
    -- Performance metrics (aggregated by hour)
    events_per_second Float32,
    avg_participation_efficiency Float32,
    
    updated_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(hour)
ORDER BY hour
TTL toDateTime(hour) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- =============================================
-- 8. VALIDATOR RANKINGS VIEW (Real-time)
-- =============================================

CREATE TABLE validator_rankings_cache (
    time_window Enum8('1h' = 1, '24h' = 2, '7d' = 3),
    rank UInt16,
    validator_id String,
    
    -- Separate metrics
    avg_block_proposal_ratio Float32,
    avg_qc_participation_rate Float32,
    avg_uptime_score Float32,
    
    -- Supporting data
    total_block_opportunities UInt32,
    total_qc_opportunities UInt32,
    total_blocks_proposed UInt32,
    total_blocks_skipped UInt32,
    total_qc_participations UInt32,
    
    -- Infrastructure
    provider LowCardinality(String),
    location LowCardinality(String),
    
    -- Metadata
    last_activity DateTime64(3, 'UTC'),
    updated_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (time_window, rank)
SETTINGS index_granularity = 8192;

-- =============================================
-- 9. GEOGRAPHIC ANALYTICS
-- =============================================

CREATE TABLE geographic_metrics_hourly (
    hour DateTime,
    location LowCardinality(String),
    provider LowCardinality(String),
    
    -- Validator counts
    active_validators UInt16,
    total_validators UInt16,
    
    -- Performance metrics
    avg_uptime_score Float32,
    avg_block_proposal_ratio Float32,
    avg_qc_participation_rate Float32,
    
    -- Activity metrics
    total_block_proposals UInt32,
    total_qc_participations UInt32,
    
    updated_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, location, provider)
TTL toDateTime(hour) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- =============================================
-- 10. PERFORMANCE PROJECTIONS
-- =============================================

-- Projection for validator rankings (most common query)
ALTER TABLE validator_metrics_hourly ADD PROJECTION rankings_proj (
    SELECT validator_id, uptime_score, block_proposal_ratio, qc_participation_rate, blocks_proposed, blocks_skipped, qc_participations, provider, location
    ORDER BY uptime_score, validator_id
);

-- Projection for time-series analysis
ALTER TABLE validator_metrics_hourly ADD PROJECTION timeseries_proj (
    SELECT hour, validator_id, uptime_score, block_proposal_ratio, qc_participation_rate
    ORDER BY hour, validator_id
);

-- =============================================
-- 11. TABLE COMMENTS
-- =============================================

ALTER TABLE raw_logs MODIFY COMMENT 'Raw log storage with compression and deduplication';
ALTER TABLE validator_registry MODIFY COMMENT 'Validator registry with DNS mapping and infrastructure info';
ALTER TABLE block_proposals MODIFY COMMENT 'Block proposal events: proposed vs skipped (from ledger.json)';
ALTER TABLE qc_participation MODIFY COMMENT 'QC participation per validator per block (from monad-bft.json BitVec)';
ALTER TABLE validator_metrics_hourly MODIFY COMMENT 'Hourly aggregated separate validator metrics';
ALTER TABLE network_health_hourly MODIFY COMMENT 'Network-wide health and consensus metrics';
ALTER TABLE validator_rankings_cache MODIFY COMMENT 'Pre-computed validator rankings for fast API responses';
ALTER TABLE geographic_metrics_hourly MODIFY COMMENT 'Geographic distribution and performance analytics';

-- =============================================
-- 12. SYSTEM OPTIMIZATION
-- =============================================

-- Set optimal merge settings for high throughput
SYSTEM RELOAD CONFIG; 