-- Migration: Add staking columns to validator_registry
-- Version: 002
-- Date: 2025-09-18
-- Description: Add precompile_validator_id and staking data columns for database-first staking approach

-- Add new columns to validator_registry table
ALTER TABLE validator_registry 
ADD COLUMN IF NOT EXISTS precompile_validator_id String DEFAULT '' COMMENT 'Precompile validator ID (1, 2, 3, ...)';

ALTER TABLE validator_registry 
ADD COLUMN IF NOT EXISTS is_staking_active UInt8 DEFAULT 0 COMMENT 'Whether validator is currently active in consensus/execution sets';

ALTER TABLE validator_registry 
ADD COLUMN IF NOT EXISTS real_time_stake_wei String DEFAULT '0' COMMENT 'Current stake amount in wei from precompile';

-- Add index for efficient queries on precompile_validator_id
ALTER TABLE validator_registry 
ADD INDEX IF NOT EXISTS idx_precompile_validator_id precompile_validator_id TYPE bloom_filter(0.01) GRANULARITY 1;

-- Add index for efficient queries on staking status
ALTER TABLE validator_registry 
ADD INDEX IF NOT EXISTS idx_is_staking_active is_staking_active TYPE set(2) GRANULARITY 1;

-- Optimize table after schema changes
OPTIMIZE TABLE validator_registry FINAL;
