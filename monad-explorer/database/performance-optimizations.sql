-- Performance Optimizations for Monad Explorer
-- Optimized for 150M+ transactions and 20M+ blocks

-- ====================================
-- 1. ADVANCED INDEXING STRATEGY
-- ====================================

-- Block optimizations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_block_timestamp_desc ON block (timestamp DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_block_number_desc ON block (number DESC);

-- Transaction performance indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_timestamp_desc ON transaction (timestamp DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_block_timestamp ON transaction (block_id, timestamp DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_from_timestamp ON transaction (from_address, timestamp DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_to_timestamp ON transaction (to_address, timestamp DESC);

-- Composite indexes for common query patterns
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_addresses_timestamp ON transaction (from_address, to_address, timestamp DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transaction_block_index ON transaction (block_id, transaction_index);

-- Log performance indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_log_address_timestamp ON log (address, timestamp);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_log_transaction_index ON log (transaction_id, log_index);

-- ====================================
-- 2. TABLE PARTITIONING STRATEGY
-- ====================================

-- Partition transactions by month (for better performance on large datasets)
-- Note: This requires migrating existing data
/*
ALTER TABLE transaction RENAME TO transaction_old;

CREATE TABLE transaction (
    id VARCHAR PRIMARY KEY,
    hash VARCHAR NOT NULL UNIQUE,
    block_id VARCHAR NOT NULL,
    transaction_index INTEGER NOT NULL,
    from_address VARCHAR NOT NULL,
    to_address VARCHAR,
    value NUMERIC NOT NULL,
    gas NUMERIC NOT NULL,
    gas_price NUMERIC NOT NULL,
    gas_used NUMERIC,
    input TEXT,
    status INTEGER,
    error TEXT,
    revert_reason TEXT,
    timestamp TIMESTAMP NOT NULL,
    nonce NUMERIC,
    type INTEGER,
    effective_gas_price NUMERIC,
    max_fee_per_gas NUMERIC,
    max_priority_fee_per_gas NUMERIC,
    contract_address VARCHAR,
    cumulative_gas_used NUMERIC,
    transaction_fee NUMERIC,
    method_name VARCHAR,
    method_id VARCHAR,
    input_decoded TEXT,
    is_contract_interaction BOOLEAN NOT NULL,
    is_contract_creation BOOLEAN NOT NULL
) PARTITION BY RANGE (timestamp);

-- Create monthly partitions (adjust dates as needed)
CREATE TABLE transaction_y2024m01 PARTITION OF transaction
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE transaction_y2024m02 PARTITION OF transaction
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- Add more partitions as needed...

-- Similarly partition blocks
ALTER TABLE block RENAME TO block_old;

CREATE TABLE block (
    id VARCHAR PRIMARY KEY,
    number INTEGER NOT NULL,
    hash VARCHAR NOT NULL UNIQUE,
    parent_hash VARCHAR NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    size NUMERIC,
    gas_limit NUMERIC NOT NULL,
    gas_used NUMERIC NOT NULL,
    transaction_count INTEGER NOT NULL,
    miner VARCHAR,
    extra_data TEXT,
    base_fee_per_gas NUMERIC
) PARTITION BY RANGE (timestamp);

CREATE TABLE block_y2024m01 PARTITION OF block
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
-- Add more partitions...
*/

-- ====================================
-- 3. AGGREGATION TABLES
-- ====================================

-- Pre-computed block statistics
CREATE TABLE IF NOT EXISTS block_stats (
    id SERIAL PRIMARY KEY,
    block_number INTEGER NOT NULL UNIQUE,
    block_hash VARCHAR NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    total_gas_used NUMERIC NOT NULL DEFAULT 0,
    avg_gas_price NUMERIC,
    total_value_transferred NUMERIC NOT NULL DEFAULT 0,
    unique_addresses INTEGER DEFAULT 0,
    contract_interactions INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_block_stats_timestamp ON block_stats (timestamp DESC);
CREATE INDEX idx_block_stats_block_number ON block_stats (block_number DESC);

-- Address statistics for faster address-based queries
CREATE TABLE IF NOT EXISTS address_stats (
    id SERIAL PRIMARY KEY,
    address VARCHAR NOT NULL UNIQUE,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    total_sent NUMERIC NOT NULL DEFAULT 0,
    total_received NUMERIC NOT NULL DEFAULT 0,
    first_seen TIMESTAMP,
    last_seen TIMESTAMP,
    is_contract BOOLEAN DEFAULT FALSE,
    token_transfers_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_address_stats_address ON address_stats (address);
CREATE INDEX idx_address_stats_transaction_count ON address_stats (transaction_count DESC);
CREATE INDEX idx_address_stats_last_seen ON address_stats (last_seen DESC);

-- Daily/hourly aggregation tables for analytics
CREATE TABLE IF NOT EXISTS daily_block_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    block_count INTEGER NOT NULL DEFAULT 0,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    total_gas_used NUMERIC NOT NULL DEFAULT 0,
    avg_gas_price NUMERIC,
    total_value_transferred NUMERIC NOT NULL DEFAULT 0,
    unique_addresses INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_daily_block_stats_date ON daily_block_stats (date DESC);

-- ====================================
-- 4. MATERIALIZED VIEWS FOR COMMON QUERIES
-- ====================================

-- Latest blocks with transaction counts (refreshed periodically)
CREATE MATERIALIZED VIEW IF NOT EXISTS latest_blocks_with_stats AS
SELECT 
    b.id,
    b.number,
    b.hash,
    b.parent_hash,
    b.timestamp,
    b.gas_used,
    b.gas_limit,
    b.base_fee_per_gas,
    b.size,
    COALESCE(bs.transaction_count, 0) as transaction_count
FROM block b
LEFT JOIN block_stats bs ON b.number = bs.block_number
ORDER BY b.number DESC
LIMIT 1000;

CREATE UNIQUE INDEX idx_latest_blocks_stats_number ON latest_blocks_with_stats (number DESC);

-- Latest transactions with minimal data for preview
CREATE MATERIALIZED VIEW IF NOT EXISTS latest_transactions_preview AS
SELECT 
    t.id,
    t.hash,
    t.from_address,
    t.to_address,
    t.value,
    t.gas_used,
    t.gas_price,
    t.timestamp,
    t.status,
    t.is_contract_interaction,
    t.is_contract_creation,
    b.number as block_number
FROM transaction t
JOIN block b ON t.block_id = b.id
ORDER BY t.timestamp DESC
LIMIT 10000;

CREATE INDEX idx_latest_transactions_timestamp ON latest_transactions_preview (timestamp DESC);

-- ====================================
-- 5. REFRESH FUNCTIONS FOR MATERIALIZED VIEWS
-- ====================================

-- Function to refresh materialized views
CREATE OR REPLACE FUNCTION refresh_performance_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY latest_blocks_with_stats;
    REFRESH MATERIALIZED VIEW CONCURRENTLY latest_transactions_preview;
END;
$$ LANGUAGE plpgsql;

-- ====================================
-- 6. STATISTICS UPDATE FUNCTIONS
-- ====================================

-- Function to update block statistics
CREATE OR REPLACE FUNCTION update_block_stats(block_num INTEGER)
RETURNS void AS $$
DECLARE
    tx_count INTEGER;
    total_gas NUMERIC;
    avg_gas NUMERIC;
    total_value NUMERIC;
    unique_addr INTEGER;
    contract_int INTEGER;
    block_ts TIMESTAMP;
    block_hash_val VARCHAR;
BEGIN
    -- Get block info
    SELECT timestamp, hash INTO block_ts, block_hash_val
    FROM block WHERE number = block_num;
    
    -- Calculate transaction statistics
    SELECT 
        COUNT(*),
        COALESCE(SUM(gas_used), 0),
        COALESCE(AVG(gas_price), 0),
        COALESCE(SUM(value), 0),
        COUNT(DISTINCT from_address) + COUNT(DISTINCT to_address),
        COUNT(*) FILTER (WHERE is_contract_interaction = true)
    INTO tx_count, total_gas, avg_gas, total_value, unique_addr, contract_int
    FROM transaction t
    JOIN block b ON t.block_id = b.id
    WHERE b.number = block_num;
    
    -- Insert or update block stats
    INSERT INTO block_stats (
        block_number, block_hash, timestamp, transaction_count, 
        total_gas_used, avg_gas_price, total_value_transferred,
        unique_addresses, contract_interactions
    ) VALUES (
        block_num, block_hash_val, block_ts, tx_count,
        total_gas, avg_gas, total_value, unique_addr, contract_int
    )
    ON CONFLICT (block_number) DO UPDATE SET
        transaction_count = EXCLUDED.transaction_count,
        total_gas_used = EXCLUDED.total_gas_used,
        avg_gas_price = EXCLUDED.avg_gas_price,
        total_value_transferred = EXCLUDED.total_value_transferred,
        unique_addresses = EXCLUDED.unique_addresses,
        contract_interactions = EXCLUDED.contract_interactions,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to update address statistics
CREATE OR REPLACE FUNCTION update_address_stats(addr VARCHAR)
RETURNS void AS $$
DECLARE
    tx_count INTEGER;
    sent_total NUMERIC;
    received_total NUMERIC;
    first_tx TIMESTAMP;
    last_tx TIMESTAMP;
    is_contract_addr BOOLEAN;
BEGIN
    -- Calculate address statistics
    SELECT 
        COUNT(*),
        COALESCE(SUM(CASE WHEN from_address = addr THEN value ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN to_address = addr THEN value ELSE 0 END), 0),
        MIN(timestamp),
        MAX(timestamp)
    INTO tx_count, sent_total, received_total, first_tx, last_tx
    FROM transaction
    WHERE from_address = addr OR to_address = addr;
    
    -- Check if address is a contract
    SELECT EXISTS(SELECT 1 FROM account WHERE address = addr AND is_contract = true)
    INTO is_contract_addr;
    
    -- Insert or update address stats
    INSERT INTO address_stats (
        address, transaction_count, total_sent, total_received,
        first_seen, last_seen, is_contract
    ) VALUES (
        addr, tx_count, sent_total, received_total,
        first_tx, last_tx, is_contract_addr
    )
    ON CONFLICT (address) DO UPDATE SET
        transaction_count = EXCLUDED.transaction_count,
        total_sent = EXCLUDED.total_sent,
        total_received = EXCLUDED.total_received,
        first_seen = EXCLUDED.first_seen,
        last_seen = EXCLUDED.last_seen,
        is_contract = EXCLUDED.is_contract,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- ====================================
-- 7. MAINTENANCE TASKS
-- ====================================

-- Create procedure for periodic maintenance
CREATE OR REPLACE FUNCTION perform_maintenance()
RETURNS void AS $$
BEGIN
    -- Update statistics
    ANALYZE block;
    ANALYZE transaction;
    ANALYZE log;
    
    -- Refresh materialized views
    PERFORM refresh_performance_views();
    
    -- Update daily stats (if not already done)
    INSERT INTO daily_block_stats (date, block_count, transaction_count)
    SELECT 
        date_trunc('day', timestamp)::date,
        COUNT(DISTINCT number),
        SUM(transaction_count)
    FROM block
    WHERE date_trunc('day', timestamp)::date = CURRENT_DATE - INTERVAL '1 day'
    GROUP BY date_trunc('day', timestamp)::date
    ON CONFLICT (date) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ====================================
-- 8. QUERY PLAN OPTIMIZATION SETTINGS
-- ====================================

-- Optimize PostgreSQL settings for blockchain data
-- (These should be set in postgresql.conf)
/*
-- Memory settings
shared_buffers = '2GB'
effective_cache_size = '6GB'
work_mem = '256MB'
maintenance_work_mem = '1GB'

-- Query planner settings
random_page_cost = 1.1
seq_page_cost = 1.0
cpu_tuple_cost = 0.01
cpu_index_tuple_cost = 0.005

-- Checkpoint settings
checkpoint_segments = 64
checkpoint_completion_target = 0.9
wal_buffers = '64MB'

-- Connection settings
max_connections = 200
*/ 