-- Migration Step 1: Add commission columns only
-- Description: Add commission columns to validator registry tables

USE monad_analytics;

-- Add commission columns to base registry table
ALTER TABLE monad_analytics.validator_registry
  ADD COLUMN commission String DEFAULT '0';

ALTER TABLE monad_analytics.validator_registry
  ADD COLUMN consensus_commission String DEFAULT '0';

ALTER TABLE monad_analytics.validator_registry
  ADD COLUMN snapshot_commission String DEFAULT '0';

-- Add commission columns to latest snapshot table
ALTER TABLE monad_analytics.validator_registry_latest
  ADD COLUMN commission String DEFAULT '0';

ALTER TABLE monad_analytics.validator_registry_latest
  ADD COLUMN consensus_commission String DEFAULT '0';

ALTER TABLE monad_analytics.validator_registry_latest
  ADD COLUMN snapshot_commission String DEFAULT '0';