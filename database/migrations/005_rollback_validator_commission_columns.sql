-- Rollback: Remove validator commission columns from registry tables

DROP VIEW IF EXISTS validator_registry_latest_mv;

ALTER TABLE IF EXISTS validator_registry_latest
  DROP COLUMN IF EXISTS snapshot_commission;

ALTER TABLE IF EXISTS validator_registry_latest
  DROP COLUMN IF EXISTS consensus_commission;

ALTER TABLE IF EXISTS validator_registry_latest
  DROP COLUMN IF EXISTS commission;

ALTER TABLE validator_registry
  DROP COLUMN IF EXISTS snapshot_commission;

ALTER TABLE validator_registry
  DROP COLUMN IF EXISTS consensus_commission;

ALTER TABLE validator_registry
  DROP COLUMN IF EXISTS commission;

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
