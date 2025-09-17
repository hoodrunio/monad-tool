-- Migration: Add staking-related fields to validator_registry table
-- This migration adds new fields to support Monad's staking precompile integration

-- Add new columns to existing validator_registry table
ALTER TABLE validator_registry 
ADD COLUMN IF NOT EXISTS is_in_consensus_set UInt8 DEFAULT 0,
ADD COLUMN IF NOT EXISTS is_in_snapshot_set UInt8 DEFAULT 0,
ADD COLUMN IF NOT EXISTS is_in_execution_set UInt8 DEFAULT 0,
ADD COLUMN IF NOT EXISTS auth_address String DEFAULT '',
ADD COLUMN IF NOT EXISTS commission String DEFAULT '0',
ADD COLUMN IF NOT EXISTS consensus_stake String DEFAULT '0',
ADD COLUMN IF NOT EXISTS snapshot_stake String DEFAULT '0',
ADD COLUMN IF NOT EXISTS flags UInt32 DEFAULT 0,
ADD COLUMN IF NOT EXISTS secp_pubkey String DEFAULT '',
ADD COLUMN IF NOT EXISTS bls_pubkey String DEFAULT '',
ADD COLUMN IF NOT EXISTS unclaimed_reward String DEFAULT '0',
ADD COLUMN IF NOT EXISTS acc_reward_per_token String DEFAULT '0',
ADD COLUMN IF NOT EXISTS staking_epoch UInt64 DEFAULT 0;

-- Create new table for validator status history
CREATE TABLE IF NOT EXISTS validator_status_history (
    validator_id String,
    epoch UInt64,
    status Enum8('active' = 1, 'inactive' = 0),
    stake String,
    consensus_stake String,
    is_in_consensus_set UInt8,
    is_in_snapshot_set UInt8,
    is_in_execution_set UInt8,
    commission String,
    flags UInt32,
    timestamp DateTime,
    INDEX idx_validator_epoch (validator_id, epoch),
    INDEX idx_status_epoch (status, epoch),
    INDEX idx_timestamp (timestamp)
) ENGINE = ReplacingMergeTree(timestamp)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (validator_id, epoch, timestamp);

-- Create new table for epoch transitions
CREATE TABLE IF NOT EXISTS epoch_transitions (
    epoch UInt64,
    previous_epoch UInt64,
    transition_time DateTime,
    active_validators_count UInt32,
    inactive_validators_count UInt32,
    total_stake String,
    consensus_set_size UInt32,
    snapshot_set_size UInt32,
    execution_set_size UInt32,
    in_epoch_delay_period UInt8,
    INDEX idx_epoch (epoch),
    INDEX idx_transition_time (transition_time)
) ENGINE = ReplacingMergeTree(transition_time)
PARTITION BY toYYYYMM(transition_time)
ORDER BY (epoch, transition_time);

-- Create materialized view for validator status aggregations
CREATE MATERIALIZED VIEW IF NOT EXISTS validator_status_summary
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (validator_id, status, toStartOfHour(timestamp))
AS SELECT
    validator_id,
    status,
    toStartOfHour(timestamp) as hour,
    count() as status_count,
    avg(toFloat64(stake)) as avg_stake,
    max(epoch) as latest_epoch
FROM validator_status_history
GROUP BY validator_id, status, hour;

-- Insert initial data migration query (to be run after deployment)
-- This will populate the new fields for existing validators
-- Note: This should be run as a separate script after the schema changes

/*
-- Example data migration (adjust based on your current data):
INSERT INTO validator_status_history (
    validator_id,
    epoch,
    status,
    stake,
    consensus_stake,
    is_in_consensus_set,
    is_in_snapshot_set,
    is_in_execution_set,
    commission,
    flags,
    timestamp
)
SELECT 
    validator_id,
    epoch,
    CASE WHEN is_active = 1 THEN 'active' ELSE 'inactive' END as status,
    toString(stake) as stake,
    '0' as consensus_stake,
    is_active as is_in_consensus_set,
    0 as is_in_snapshot_set,
    1 as is_in_execution_set,
    '0' as commission,
    0 as flags,
    last_updated as timestamp
FROM validator_registry
WHERE validator_id IS NOT NULL;
*/

-- Add comments to document the new fields
ALTER TABLE validator_registry 
COMMENT COLUMN is_in_consensus_set 'Whether validator is in current consensus set (active)',
COMMENT COLUMN is_in_snapshot_set 'Whether validator is in snapshot set',
COMMENT COLUMN is_in_execution_set 'Whether validator is in execution set (registered)',
COMMENT COLUMN auth_address 'Validator authority address from staking precompile',
COMMENT COLUMN commission 'Validator commission rate from staking precompile',
COMMENT COLUMN consensus_stake 'Validator stake in consensus set',
COMMENT COLUMN snapshot_stake 'Validator stake in snapshot set',
COMMENT COLUMN flags 'Validator flags from staking precompile',
COMMENT COLUMN secp_pubkey 'SECP256K1 public key for consensus',
COMMENT COLUMN bls_pubkey 'BLS public key for consensus',
COMMENT COLUMN unclaimed_reward 'Unclaimed rewards amount',
COMMENT COLUMN acc_reward_per_token 'Accumulated reward per token',
COMMENT COLUMN staking_epoch 'Epoch when staking data was last updated';
