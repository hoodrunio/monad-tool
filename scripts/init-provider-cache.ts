#!/usr/bin/env ts-node

/**
 * Initialize Provider Performance Cache
 * 
 * This script sets up the new provider_performance_cache table and
 * starts the background calculation service for the first time.
 */

import 'dotenv/config';
import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { MonadRedisClient } from '../src/cache/redis-client';
import { ProviderPerformanceCacheService } from '../src/services/provider-performance-cache';

async function initializeProviderCache(): Promise<void> {
  console.log('🚀 Initializing Provider Performance Cache System...');

  const clickhouseConfig = {
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    max_open_connections: 10,
    max_query_timeout: 30000,
    compression: true
  };

  const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'monad:',
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 1000,
    maxMemoryPolicy: 'allkeys-lru',
    defaultTtl: 300
  };

  const clickhouseClient = new MonadClickHouseClient(clickhouseConfig);
  const redisClient = new MonadRedisClient(redisConfig);

  try {
    // Test connections
    console.log('🔗 Testing database connections...');
    const [clickhouseHealthy, redisHealthy] = await Promise.all([
      clickhouseClient.ping(),
      redisClient.ping()
    ]);

    if (!clickhouseHealthy) {
      throw new Error('ClickHouse connection failed');
    }

    if (!redisHealthy) {
      throw new Error('Redis connection failed');
    }

    console.log('✅ Database connections established');

    // Check if the new table exists
    console.log('📋 Checking provider_performance_cache table...');
    const tableExistsQuery = `
      SELECT count() as table_exists 
      FROM system.tables 
      WHERE database = '${clickhouseConfig.database}' 
        AND name = 'provider_performance_cache'
    `;

    const tableResult = await clickhouseClient.executeRawQuery(tableExistsQuery);
    const tableExists = tableResult[0]?.table_exists > 0;

    if (!tableExists) {
      console.log('📋 Creating provider_performance_cache table...');
      
      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS provider_performance_cache (
          provider String,
          
          -- Performance metrics
          avg_performance Float32,
          validator_count UInt32,
          active_validator_count UInt32,
          
          -- Geographic data
          regions Array(String),
          datacenters Array(String),
          unique_locations UInt16,
          
          -- Block proposal metrics
          total_proposals UInt64,
          successful_proposals UInt64,
          block_success_rate Float32,
          
          -- QC participation metrics
          total_qc_opportunities UInt64,
          successful_qc_participations UInt64,
          qc_participation_rate Float32,
          
          -- Cache metadata
          calculated_at DateTime64(3, 'UTC') DEFAULT now(),
          data_window_start DateTime64(3, 'UTC'),
          data_window_end DateTime64(3, 'UTC'),
          last_updated DateTime64(3, 'UTC') DEFAULT now(),
          
          -- Background calculation metadata
          calculation_duration_ms UInt32,
          data_freshness_minutes UInt16,
          is_valid UInt8 DEFAULT 1
        ) ENGINE = ReplacingMergeTree(last_updated)
        ORDER BY provider
        TTL toDateTime(last_updated) + INTERVAL 24 HOUR
        SETTINGS index_granularity = 1024
      `;

      await clickhouseClient.executeCommand(createTableQuery);
      console.log('✅ Provider performance cache table created');
    } else {
      console.log('✅ Provider performance cache table already exists');
    }

    // Check if we have basic validator data
    console.log('👥 Checking validator registry data...');
    const validatorCountQuery = `
      SELECT COUNT(*) as total_validators
      FROM validator_registry
      WHERE provider IS NOT NULL AND provider != '' AND provider != 'unknown'
    `;

    const validatorResult = await clickhouseClient.executeRawQuery(validatorCountQuery);
    const totalValidators = validatorResult[0]?.total_validators || 0;

    if (totalValidators === 0) {
      console.log('⚠️ Warning: No validator data found in validator_registry table');
      console.log('   The cache service will use fallback data until validators are properly registered');
    } else {
      console.log(`✅ Found ${totalValidators} validators with provider information`);
    }

    // Initialize and start the background cache service
    console.log('🔄 Starting Provider Performance Cache Service...');
    
    const cacheService = new ProviderPerformanceCacheService(
      clickhouseClient,
      redisClient,
      {
        updateIntervalMinutes: 15,
        dataWindowHours: 168, // 7 days
        enableRedisCache: true,
        redisCacheTtlSeconds: 900,
        maxCalculationTimeoutMs: 120000,
        enableFallbackData: true
      }
    );

    // Set up event listeners for monitoring
    cacheService.on('calculationComplete', (event) => {
      console.log(`✅ Cache calculation completed: ${event.providersCount} providers in ${event.durationMs}ms`);
    });

    cacheService.on('calculationError', (error) => {
      console.error('❌ Cache calculation error:', error);
    });

    // Start the service (this will do initial calculation)
    await cacheService.start();

    // Let it run for a bit to complete the first calculation
    console.log('⏳ Waiting for initial calculation to complete...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check cache status
    const status = cacheService.getStatus();
    console.log('\n📊 Cache Service Status:');
    console.log(`   Running: ${status.isRunning}`);
    console.log(`   Calculating: ${status.isCalculating}`);
    console.log(`   Last Calculation: ${status.lastCalculationTime || 'Never'}`);
    console.log(`   Errors: ${status.calculationErrors}`);

    // Verify cache data
    const cachedData = await cacheService.getCachedPerformanceData();
    console.log(`   Cached Providers: ${cachedData.size}`);

    if (cachedData.size > 0) {
      console.log('\n✅ Provider Performance Cache System initialized successfully!');
      console.log('\n📋 Next Steps:');
      console.log('   1. The background service will update data every 15 minutes');
      console.log('   2. API endpoints will now use cached data instead of expensive queries');
      console.log('   3. Monitor cache status at: GET /api/dns/provider-cache-status');
      console.log('   4. Force updates with: POST /api/dns/force-provider-cache-update');
      
      // Show sample data
      const sampleProvider = Array.from(cachedData.entries())[0];
      if (sampleProvider) {
        console.log(`\n📈 Sample Provider Data (${sampleProvider[0]}):`);
        console.log(`   Validators: ${sampleProvider[1].validatorCount}`);
        console.log(`   Performance: ${sampleProvider[1].avgPerformance.toFixed(1)}%`);
        console.log(`   Regions: ${sampleProvider[1].regions.join(', ')}`);
      }
    } else {
      console.log('⚠️ Warning: No cached data available yet. This may be normal on first startup.');
      console.log('   Check logs for calculation errors or wait for the next update cycle.');
    }

    // Stop the service for this initialization script
    cacheService.stop();

  } catch (error) {
    console.error('❌ Failed to initialize Provider Performance Cache:', error);
    process.exit(1);
  } finally {
    await Promise.all([
      clickhouseClient.close(),
      redisClient.close()
    ]);
  }
}

// Run if called directly
if (require.main === module) {
  initializeProviderCache()
    .then(() => {
      console.log('\n🎉 Initialization complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Initialization failed:', error);
      process.exit(1);
    });
}

export { initializeProviderCache }; 