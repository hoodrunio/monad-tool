#!/bin/bash

# Monad Explorer - Database Optimization Restart Script
# This script restarts the services with optimized PostgreSQL configuration

echo "🚀 Restarting Monad Explorer with Database Optimizations..."

# Stop existing containers
echo "⏹️  Stopping existing containers..."
docker-compose down

# Remove old PostgreSQL container to force recreation
echo "🗑️  Removing old PostgreSQL container to apply new config..."
docker container rm monad-explorer-db-secure 2>/dev/null || true

# Pull latest images if needed
echo "📥 Pulling latest images..."
docker-compose pull

# Start services with new configuration
echo "🏗️  Starting services with optimized configuration..."
docker-compose up -d

# Wait for database to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker-compose exec -T db pg_isready -U squid_user -d squid > /dev/null 2>&1; then
        echo "✅ PostgreSQL is ready!"
        break
    fi
    echo "   Waiting... ($i/30)"
    sleep 2
done

# Show memory usage
echo ""
echo "📊 Memory Configuration Applied:"
echo "   - PostgreSQL shared_buffers: 5GB"
echo "   - PostgreSQL effective_cache_size: 15GB"
echo "   - PostgreSQL work_mem: 32MB"
echo "   - Node.js max memory: 8GB"
echo "   - Docker container limit: 8GB"

# Show container status
echo ""
echo "📋 Container Status:"
docker-compose ps

# Show PostgreSQL configuration verification
echo ""
echo "🔧 Verifying PostgreSQL Configuration:"
docker-compose exec db psql -U squid_user -d squid -c "SHOW shared_buffers; SHOW effective_cache_size; SHOW work_mem;" 2>/dev/null || echo "   Database not ready yet, check manually later"

echo ""
echo "✅ Restart completed! Monitor performance with:"
echo "   docker-compose logs -f"
echo "   docker stats"

# Show performance monitoring commands
echo ""
echo "📈 Performance Monitoring Commands:"
echo "   - Container stats: docker stats"
echo "   - Database logs: docker-compose logs db"
echo "   - Application logs: docker-compose logs app"
echo "   - Memory usage: docker exec monad-explorer-db-secure ps aux"
echo "   - PostgreSQL config: docker exec monad-explorer-db-secure psql -U squid_user -d squid -c 'SHOW ALL;'" 