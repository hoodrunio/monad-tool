-- Migration: Add GitHub validator registry fields
-- Date: 2025-11-03
-- Description: Adds validator_website, validator_logo_url, validator_description, and validator_x_handle fields

-- Add new columns to validator_registry table
ALTER TABLE validator_registry
ADD COLUMN IF NOT EXISTS validator_website String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_logo_url String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_description String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_x_handle String DEFAULT '';

-- Add new columns to validator_registry_latest table
ALTER TABLE validator_registry_latest
ADD COLUMN IF NOT EXISTS validator_website String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_logo_url String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_description String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_x_handle String DEFAULT '';

-- Note: The materialized view validator_registry_latest_mv needs to be recreated
-- Drop and recreate the materialized view with updated columns
DROP VIEW IF EXISTS validator_registry_latest_mv;

CREATE MATERIALIZED VIEW validator_registry_latest_mv
TO validator_registry_latest
AS
SELECT
    validator_id,
    tupleElement(latest_record, 1) AS auth_address,
    tupleElement(latest_record, 2) AS validator_name,
    tupleElement(latest_record, 3) AS validator_website,
    tupleElement(latest_record, 4) AS validator_logo_url,
    tupleElement(latest_record, 5) AS validator_description,
    tupleElement(latest_record, 6) AS validator_x_handle,
    tupleElement(latest_record, 7) AS provider,
    tupleElement(latest_record, 8) AS location,
    tupleElement(latest_record, 9) AS country,
    tupleElement(latest_record, 10) AS datacenter,
    tupleElement(latest_record, 11) AS stake,
    tupleElement(latest_record, 12) AS real_time_stake_wei,
    tupleElement(latest_record, 13) AS commission,
    tupleElement(latest_record, 14) AS consensus_commission,
    tupleElement(latest_record, 15) AS snapshot_commission,
    tupleElement(latest_record, 16) AS is_staking_active,
    tupleElement(latest_record, 17) AS keybase_id,
    tupleElement(latest_record, 18) AS keybase_logo_url,
    tupleElement(latest_record, 19) AS last_updated
FROM (
    SELECT
        validator_id,
        argMax((
          auth_address,
          validator_name,
          validator_website,
          validator_logo_url,
          validator_description,
          validator_x_handle,
          provider,
          location,
          country,
          datacenter,
          stake,
          real_time_stake_wei,
          commission,
          consensus_commission,
          snapshot_commission,
          is_staking_active,
          keybase_id,
          keybase_logo_url,
          last_updated
        ), last_updated) AS latest_record
    FROM validator_registry
    WHERE is_active = 1
    GROUP BY validator_id
);
