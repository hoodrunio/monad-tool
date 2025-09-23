-- Migration: Add validator commission columns to registry tables
-- Description: Stores commission rates returned by the staking precompile for each validator snapshot

USE monad_analytics;

-- Extend base registry table with commission columns
ALTER TABLE monad_analytics.validator_registry
  ADD COLUMN IF NOT EXISTS commission String DEFAULT '0' AFTER last_updated;

ALTER TABLE monad_analytics.validator_registry
  ADD COLUMN IF NOT EXISTS consensus_commission String DEFAULT '0' AFTER commission;

ALTER TABLE monad_analytics.validator_registry
  ADD COLUMN IF NOT EXISTS snapshot_commission String DEFAULT '0' AFTER consensus_commission;

-- Ensure latest snapshot table mirrors the new schema
ALTER TABLE monad_analytics.validator_registry_latest
  ADD COLUMN IF NOT EXISTS commission String DEFAULT '0' AFTER last_updated;

ALTER TABLE monad_analytics.validator_registry_latest
  ADD COLUMN IF NOT EXISTS consensus_commission String DEFAULT '0' AFTER commission;

ALTER TABLE monad_analytics.validator_registry_latest
  ADD COLUMN IF NOT EXISTS snapshot_commission String DEFAULT '0' AFTER consensus_commission;
