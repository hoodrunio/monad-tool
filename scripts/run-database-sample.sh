#!/bin/bash

# Monad Database Sampling Script Runner
# Retrieves sample data from all ClickHouse tables

set -e

echo "🚀 Starting Monad Database Sampling..."

# Check if tsx is available
if ! command -v tsx &> /dev/null; then
    echo "❌ tsx is not installed. Installing..."
    npm install -g tsx
fi

# Set default environment variables if not provided
export CLICKHOUSE_HOST=${CLICKHOUSE_HOST:-localhost}
export CLICKHOUSE_PORT=${CLICKHOUSE_PORT:-8123}
export CLICKHOUSE_USER=${CLICKHOUSE_USER:-default}
export CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:-}
export CLICKHOUSE_DATABASE=${CLICKHOUSE_DATABASE:-monad_analytics}
export LOG_LEVEL=${LOG_LEVEL:-info}

echo "🔧 Configuration:"
echo "  Host: $CLICKHOUSE_HOST"
echo "  Port: $CLICKHOUSE_PORT"
echo "  Database: $CLICKHOUSE_DATABASE"
echo "  User: $CLICKHOUSE_USER"
echo ""

# Run the sampling script
echo "📊 Executing database sampling script..."
tsx scripts/sample-database-data.ts

echo ""
echo "✅ Database sampling completed!" 