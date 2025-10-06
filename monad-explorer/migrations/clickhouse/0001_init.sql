CREATE DATABASE IF NOT EXISTS monad_explorer;

CREATE TABLE IF NOT EXISTS monad_explorer.blocks_cold (
    batch_id String,
    ingested_at DateTime DEFAULT now(),
    block_number UInt64,
    block_hash String,
    parent_hash Nullable(String),
    block_timestamp DateTime,
    size String,
    gas_limit String,
    gas_used String,
    transaction_count UInt32,
    miner Nullable(String),
    extra_data Nullable(String),
    base_fee_per_gas String
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_timestamp)
PRIMARY KEY block_number
ORDER BY block_number;

CREATE TABLE IF NOT EXISTS monad_explorer.transactions_cold (
    batch_id String,
    ingested_at DateTime DEFAULT now(),
    block_id String,
    block_number UInt64,
    block_timestamp DateTime,
    transaction_hash String,
    transaction_index UInt32,
    from_address String,
    to_address Nullable(String),
    value String,
    gas String,
    gas_price String,
    gas_used String,
    max_fee_per_gas String,
    max_priority_fee_per_gas String,
    input Nullable(String),
    status Nullable(Int8),
    nonce String,
    type Nullable(Int8),
    method_id Nullable(String),
    method_name Nullable(String),
    is_contract_creation UInt8,
    is_contract_interaction UInt8,
    contract_address Nullable(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_timestamp)
PRIMARY KEY (block_number, transaction_hash)
ORDER BY (block_number, transaction_hash, transaction_index);

CREATE TABLE IF NOT EXISTS monad_explorer.logs_cold (
    batch_id String,
    ingested_at DateTime DEFAULT now(),
    block_number UInt64,
    block_timestamp DateTime,
    transaction_hash String,
    log_index UInt32,
    address String,
    topics Array(String),
    data String
) ENGINE = MergeTree
PARTITION BY toYYYYMM(block_timestamp)
PRIMARY KEY (block_number, transaction_hash, log_index)
ORDER BY (block_number, transaction_hash, log_index);
