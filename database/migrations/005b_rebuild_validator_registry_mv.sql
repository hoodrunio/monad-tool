-- Migration: Rebuild validator registry materialized view with commission columns
-- Description: Updates the materialized view to include the new commission columns

USE monad_analytics;

-- Rebuild materialized view to expose new metrics
DROP VIEW IF EXISTS monad_analytics.validator_registry_latest_mv;

TRUNCATE TABLE IF EXISTS monad_analytics.validator_registry_latest;

CREATE MATERIALIZED VIEW IF NOT EXISTS monad_analytics.validator_registry_latest_mv
TO monad_analytics.validator_registry_latest
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
    FROM monad_analytics.validator_registry
    WHERE is_active = 1
    GROUP BY validator_id
)
POPULATE;

-- Optimize tables after schema change
OPTIMIZE TABLE monad_analytics.validator_registry FINAL;
OPTIMIZE TABLE monad_analytics.validator_registry_latest FINAL;