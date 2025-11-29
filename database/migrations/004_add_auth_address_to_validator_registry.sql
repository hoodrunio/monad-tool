-- Migration: Add auth_address column to validator registry tables and rebuild latest snapshot MV
-- Description: Stores validator authentication addresses fetched from staking precompile

-- Ensure base registry table has the new column
ALTER TABLE validator_registry 
  ADD COLUMN IF NOT EXISTS auth_address String DEFAULT '' AFTER node_id;

-- Ensure latest snapshot table schema matches
ALTER TABLE IF EXISTS validator_registry_latest 
  ADD COLUMN IF NOT EXISTS auth_address String DEFAULT '' AFTER validator_id;

-- Drop existing materialized view so it can be recreated with the new column
DROP VIEW IF EXISTS validator_registry_latest_mv;

-- Clear existing latest snapshot data before repopulating
TRUNCATE TABLE IF EXISTS validator_registry_latest;

-- Recreate materialized view with auth_address support and repopulate snapshot
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
    tupleElement(latest_record, 9) AS keybase_id,
    tupleElement(latest_record, 10) AS keybase_logo_url,
    tupleElement(latest_record, 11) AS last_updated
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
          keybase_id,
          keybase_logo_url,
          last_updated
        ), last_updated) AS latest_record
    FROM validator_registry
    WHERE is_active = 1
    GROUP BY validator_id
)
POPULATE;

-- Optimize base table after schema change
OPTIMIZE TABLE validator_registry FINAL;
