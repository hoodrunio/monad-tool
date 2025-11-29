-- Migration: Create consolidated validator registry snapshot table and materialized view
-- Purpose: provide a single authoritative row per validator to eliminate join fan-out

DROP TABLE IF EXISTS validator_registry_latest;
DROP VIEW IF EXISTS validator_registry_latest_mv;

CREATE TABLE IF NOT EXISTS validator_registry_latest (
    validator_id String,
    auth_address String,
    validator_name LowCardinality(String),
    provider LowCardinality(String),
    location LowCardinality(String),
    country LowCardinality(String),
    datacenter LowCardinality(String),
    stake UInt64,
    real_time_stake_wei String,
    keybase_id LowCardinality(String),
    keybase_logo_url String,
    last_updated DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(last_updated)
ORDER BY validator_id
SETTINGS index_granularity = 8192;

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
);

TRUNCATE TABLE validator_registry_latest;

INSERT INTO validator_registry_latest
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
);
