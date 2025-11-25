-- Migration: 008_add_tip_revenue_tables
-- Description: Add tables for tracking validator tip/priority fee revenue
-- Date: 2025-01-25

-- =============================================
-- 1. RAW TIP REVENUE DATA (Block-level)
-- =============================================

CREATE TABLE IF NOT EXISTS tip_revenue_raw (
    block_number UInt64,
    block_timestamp DateTime64(3, 'UTC'),
    validator_id String COMMENT 'Node ID (secp pubkey) of block proposer',
    proposer_address String COMMENT 'Block miner/coinbase address',

    -- Tip metrics
    total_tip_wei String COMMENT 'Total tips in wei',
    transaction_count UInt32,
    base_fee_per_gas String,

    -- Processing metadata
    ingestion_id UUID DEFAULT generateUUIDv4(),
    processed_at DateTime64(3, 'UTC') DEFAULT now(),

    INDEX idx_validator_id validator_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_timestamp block_timestamp TYPE minmax GRANULARITY 1,
    INDEX idx_proposer_address proposer_address TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_number)
TTL toDateTime(block_timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- =============================================
-- 2. HOURLY AGGREGATED TIP REVENUE
-- =============================================

CREATE TABLE IF NOT EXISTS tip_revenue_hourly (
    hour DateTime,
    validator_id String,

    -- Aggregated tip metrics
    total_tip_wei String COMMENT 'Total tips earned in hour (wei)',
    total_tip_mon Float64 COMMENT 'Total tips earned in hour (MON)',
    blocks_proposed UInt32,
    total_transactions UInt32,
    avg_tip_per_block_wei String,
    avg_tip_per_tx_wei String,
    min_tip_wei String,
    max_tip_wei String,

    -- Metadata
    updated_at DateTime64(3, 'UTC') DEFAULT now(),

    INDEX idx_tip_mon (total_tip_mon) TYPE minmax GRANULARITY 1,
    INDEX idx_validator_id validator_id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, validator_id)
TTL toDateTime(hour) + INTERVAL 180 DAY
SETTINGS index_granularity = 8192;

-- =============================================
-- 3. CUMULATIVE TIP REVENUE
-- =============================================

CREATE TABLE IF NOT EXISTS tip_revenue_cumulative (
    validator_id String,

    -- Cumulative metrics
    total_tip_wei String,
    total_tip_mon Float64,
    total_blocks_proposed UInt64,
    total_transactions UInt64,
    avg_tip_per_block_mon Float64,

    -- Time tracking
    first_block_timestamp DateTime64(3, 'UTC'),
    last_block_timestamp DateTime64(3, 'UTC'),
    last_updated DateTime64(3, 'UTC') DEFAULT now(),

    INDEX idx_total_tip_mon (total_tip_mon) TYPE minmax GRANULARITY 1
) ENGINE = ReplacingMergeTree(last_updated)
ORDER BY (validator_id)
SETTINGS index_granularity = 8192;

-- =============================================
-- 4. TIP REVENUE SYNC STATE
-- =============================================

CREATE TABLE IF NOT EXISTS tip_revenue_sync_state (
    key String,
    value String,
    updated_at DateTime64(3, 'UTC') DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (key)
SETTINGS index_granularity = 8192;
