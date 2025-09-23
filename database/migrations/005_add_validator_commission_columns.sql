-- Migration: Add validator commission columns to registry tables
-- Description: Stores commission rates returned by the staking precompile for each validator snapshot

-- Extend base registry table with commission columns
ALTER TABLE validator_registry
  ADD COLUMN IF NOT EXISTS commission String DEFAULT '0' AFTER real_time_stake_wei;

ALTER TABLE validator_registry
  ADD COLUMN IF NOT EXISTS consensus_commission String DEFAULT '0' AFTER commission;

ALTER TABLE validator_registry
  ADD COLUMN IF NOT EXISTS snapshot_commission String DEFAULT '0' AFTER consensus_commission;

-- Ensure latest snapshot table mirrors the new schema
ALTER TABLE IF EXISTS validator_registry_latest
  ADD COLUMN IF NOT EXISTS commission String DEFAULT '0' AFTER real_time_stake_wei;

ALTER TABLE IF EXISTS validator_registry_latest
  ADD COLUMN IF NOT EXISTS consensus_commission String DEFAULT '0' AFTER commission;

ALTER TABLE IF EXISTS validator_registry_latest
  ADD COLUMN IF NOT EXISTS snapshot_commission String DEFAULT '0' AFTER consensus_commission;

-- Rebuild materialized view to expose new metrics
DROP VIEW IF EXISTS validator_registry_latest_mv;

TRUNCATE TABLE IF EXISTS validator_registry_latest;

CREATE MATERIALIZED VIEW IF NOT EXISTS validator_registry_latest_mv
TO validator_registry_latest
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
    FROM validator_registry
    WHERE is_active = 1
    GROUP BY validator_id
)
POPULATE;

-- Optimize tables after schema change
OPTIMIZE TABLE validator_registry FINAL;
OPTIMIZE TABLE validator_registry_latest FINAL;
