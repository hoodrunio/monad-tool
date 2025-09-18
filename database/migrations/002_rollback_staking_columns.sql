-- Rollback Migration: Remove staking columns from validator_registry  
-- Version: 002_rollback
-- Date: 2025-09-18
-- Description: Rollback staking columns if needed

-- Remove indexes first
ALTER TABLE validator_registry DROP INDEX IF EXISTS idx_precompile_validator_id;
ALTER TABLE validator_registry DROP INDEX IF EXISTS idx_is_staking_active;

-- Remove columns
ALTER TABLE validator_registry DROP COLUMN IF EXISTS precompile_validator_id;
ALTER TABLE validator_registry DROP COLUMN IF EXISTS is_staking_active;
ALTER TABLE validator_registry DROP COLUMN IF EXISTS real_time_stake_wei;

-- Optimize table after schema changes
OPTIMIZE TABLE validator_registry FINAL;
