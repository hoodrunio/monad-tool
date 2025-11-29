#!/usr/bin/env ts-node

import 'dotenv/config';
import { MonadRedisClient } from '../src/cache/redis-client';

async function clearAPICache() {
  console.log('🧹 Clearing API Cache to Serve Fresh Provider Data...\n');

  const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'monad:',
    maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES || '3'),
    retryDelayOnFailover: parseInt(process.env.REDIS_RETRY_DELAY || '1000'),
    maxMemoryPolicy: process.env.REDIS_MEMORY_POLICY || 'allkeys-lru',
    defaultTtl: parseInt(process.env.REDIS_DEFAULT_TTL || '300')
  };

  const redisClient = new MonadRedisClient(redisConfig);

  try {
    // Test connection
    console.log('🔗 Connecting to Redis...');
    
    // Clear all cache keys related to validator rankings and details
    console.log('🗑️  Clearing validator rankings cache...');
    const rankingKeys = await redisClient['client'].keys('validator_rankings:*');
    if (rankingKeys.length > 0) {
      await redisClient['client'].del(...rankingKeys);
      console.log(`✅ Cleared ${rankingKeys.length} ranking cache entries`);
    } else {
      console.log('ℹ️  No ranking cache entries found');
    }

    console.log('🗑️  Clearing validator history cache...');
    const historyKeys = await redisClient['client'].keys('validator_history:*');
    if (historyKeys.length > 0) {
      await redisClient['client'].del(...historyKeys);
      console.log(`✅ Cleared ${historyKeys.length} history cache entries`);
    } else {
      console.log('ℹ️  No history cache entries found');
    }

    console.log('🗑️  Clearing validator details cache...');
    const detailsKeys = await redisClient['client'].keys('validator_details:*');
    if (detailsKeys.length > 0) {
      await redisClient['client'].del(...detailsKeys);
      console.log(`✅ Cleared ${detailsKeys.length} details cache entries`);
    } else {
      console.log('ℹ️  No details cache entries found');
    }

    console.log('🗑️  Clearing comparison cache...');
    const comparisonKeys = await redisClient['client'].keys('validator_comparison:*');
    if (comparisonKeys.length > 0) {
      await redisClient['client'].del(...comparisonKeys);
      console.log(`✅ Cleared ${comparisonKeys.length} comparison cache entries`);
    } else {
      console.log('ℹ️  No comparison cache entries found');
    }

    // Get cache statistics
    console.log('\n📊 Cache Statistics:');
    const dbSize = await redisClient['client'].dbsize();
    const info = await redisClient['client'].info('memory');
    const memoryUsage = info.match(/used_memory_human:(.+)/)?.[1]?.trim();
    
    console.log(`   Total keys in database: ${dbSize}`);
    console.log(`   Memory usage: ${memoryUsage || 'unknown'}`);

    console.log('\n🎉 API cache cleared successfully!');
    console.log('📡 Next API requests will fetch fresh data with correct provider information');

  } catch (error) {
    console.error('❌ Error clearing API cache:', error);
  } finally {
    await redisClient.close();
  }
}

// Run the cache clear
if (require.main === module) {
  clearAPICache().catch(console.error);
}

export { clearAPICache }; 