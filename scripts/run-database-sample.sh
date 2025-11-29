#!/bin/bash

# Monad Database Sampling Script Runner
# Retrieves random sample data from all ClickHouse tables

set -e

# Parse command line arguments
SAMPLE_SIZE=${1:-5}  # Default to 5 if no argument provided

# Display help if requested
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "🎲 Monad Database Sampling Script Runner"
    echo "========================================"
    echo ""
    echo "Usage: $0 [SAMPLE_SIZE]"
    echo ""
    echo "Parameters:"
    echo "  SAMPLE_SIZE    Number of random records to sample from each table (default: 5)"
    echo ""
    echo "Examples:"
    echo "  $0           # Sample 5 records per table"
    echo "  $0 10        # Sample 10 records per table"
    echo "  $0 20        # Sample 20 records per table"
    echo ""
    echo "Environment Variables:"
    echo "  CLICKHOUSE_HOST     ClickHouse server host (default: localhost)"
    echo "  CLICKHOUSE_PORT     ClickHouse server port (default: 8123)"
    echo "  CLICKHOUSE_USER     ClickHouse username (default: default)"
    echo "  CLICKHOUSE_PASSWORD ClickHouse password (default: empty)"
    echo "  CLICKHOUSE_DATABASE Database name (default: monad_analytics)"
    exit 0
fi

echo "🚀 Starting Monad Database Sampling..."
echo "🎲 Sampling $SAMPLE_SIZE random records per table"

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
echo "  Sample Size: $SAMPLE_SIZE"
echo ""

# Run the sampling script with the specified sample size
echo "📊 Executing database sampling script..."
tsx scripts/sample-database-data.ts "$SAMPLE_SIZE"

echo ""
echo "✅ Database sampling completed!" 