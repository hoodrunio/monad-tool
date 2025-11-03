#!/bin/bash

# Apply validator registry fields migration
# Run this script to add new GitHub registry fields to the database

set -e

echo "🔄 Applying Validator Registry Fields Migration"
echo ""

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

CLICKHOUSE_HOST="${CLICKHOUSE_HOST:-localhost}"
CLICKHOUSE_PORT="${CLICKHOUSE_PORT:-8123}"
CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-monad_analytics}"
CLICKHOUSE_USER="${CLICKHOUSE_USERNAME:-default}"
CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-}"

echo "📊 Database: ${CLICKHOUSE_DATABASE} @ ${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}"
echo ""

# Construct auth parameter
AUTH_PARAM=""
if [ -n "$CLICKHOUSE_PASSWORD" ]; then
    AUTH_PARAM="--password=$CLICKHOUSE_PASSWORD"
fi

# Function to execute SQL
execute_sql() {
    local sql="$1"
    echo "Executing: $(echo "$sql" | head -c 80)..."

    curl -sS "http://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}/?database=${CLICKHOUSE_DATABASE}&user=${CLICKHOUSE_USER}${AUTH_PARAM:+&password=$CLICKHOUSE_PASSWORD}" \
        --data-binary "$sql" || {
        echo "❌ Failed to execute SQL"
        return 1
    }
    echo "✅ Success"
    echo ""
}

echo "Step 1: Adding columns to validator_registry table..."
execute_sql "ALTER TABLE validator_registry
ADD COLUMN IF NOT EXISTS validator_website String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_logo_url String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_description String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_x_handle String DEFAULT '';"

echo "Step 2: Adding columns to validator_registry_latest table..."
execute_sql "ALTER TABLE validator_registry_latest
ADD COLUMN IF NOT EXISTS validator_website String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_logo_url String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_description String DEFAULT '',
ADD COLUMN IF NOT EXISTS validator_x_handle String DEFAULT '';"

echo "Step 3: Recreating materialized view..."
execute_sql "DROP VIEW IF EXISTS validator_registry_latest_mv;"

execute_sql "CREATE MATERIALIZED VIEW validator_registry_latest_mv
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
);"

echo "✅ Migration completed successfully!"
echo ""
echo "📊 New columns added:"
echo "   • validator_website"
echo "   • validator_logo_url"
echo "   • validator_description"
echo "   • validator_x_handle"
echo ""
echo "💡 Next steps:"
echo "   1. Run: npm run update-validator-names"
echo "   2. Set GITHUB_TOKEN in .env for better rate limits"
echo "   3. Set VALIDATOR_NETWORK (testnet/mainnet) in .env"
echo ""
