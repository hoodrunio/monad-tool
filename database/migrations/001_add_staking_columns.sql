-- Migration: Add Staking Columns to validator_registry
-- Date: 2025-09-18
-- Description: Add precompile validator ID and real-time staking information

-- Add new staking columns to validator_registry table
ALTER TABLE validator_registry 
ADD COLUMN IF NOT EXISTS precompile_validator_id String DEFAULT '',
ADD COLUMN IF NOT EXISTS is_staking_active UInt8 DEFAULT 0,
ADD COLUMN IF NOT EXISTS real_time_stake_wei String DEFAULT '0',
ADD COLUMN IF NOT EXISTS last_stake_update DateTime64(3, 'UTC') DEFAULT now();

-- Create index for efficient precompile_validator_id lookups
-- ALTER TABLE validator_registry ADD INDEX IF NOT EXISTS idx_precompile_validator_id precompile_validator_id TYPE bloom_filter GRANULARITY 1;

-- Create materialized view for staking statistics (optional optimization)
-- CREATE MATERIALIZED VIEW IF NOT EXISTS validator_staking_stats
-- ENGINE = SummingMergeTree()
-- ORDER BY (epoch, is_staking_active)
-- AS SELECT
--   epoch,
--   is_staking_active,
--   count() as validator_count,
--   sum(toUInt64OrZero(real_time_stake_wei)) as total_stake_wei
-- FROM validator_registry
-- WHERE precompile_validator_id != ''
-- GROUP BY epoch, is_staking_active;

-- Add comment to track migration
-- INSERT INTO system.query_log (query_start_time, query, type) 
-- VALUES (now(), 'Migration 001: Added staking columns to validator_registry', 'DDL');
