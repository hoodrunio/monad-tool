#!/usr/bin/env ts-node

// Health check script to verify system readiness
import 'dotenv/config';

async function healthCheck() {
  console.log('🏥 Monad Analytics Health Check\n');

  let allHealthy = true;

  // Check Node.js version
  console.log('📋 System Requirements:');
  const nodeVersion = process.version;
  console.log(`  Node.js: ${nodeVersion}`);
  
  const majorVersion = parseInt(nodeVersion.substring(1).split('.')[0]);
  if (majorVersion >= 18) {
    console.log('  ✅ Node.js version compatible');
  } else {
    console.log('  ❌ Node.js 18+ required');
    allHealthy = false;
  }

  // Check environment variables
  console.log('\n🔧 Environment Configuration:');
  const requiredEnvVars = [
    'CLICKHOUSE_HOST',
    'REDIS_HOST'
  ];

  requiredEnvVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
      console.log(`  ✅ ${varName}: ${value}`);
    } else {
      console.log(`  ⚠️  ${varName}: using default`);
    }
  });

  // Test ClickHouse connectivity
  console.log('\n🗄️  ClickHouse Database:');
  try {
    const { MonadClickHouseClient } = await import('../src/database/clickhouse-client');
    
    const clickhouseConfig = {
      host: process.env.CLICKHOUSE_HOST || 'localhost',
      port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
      username: process.env.CLICKHOUSE_USERNAME || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
      max_open_connections: 5,
      max_query_timeout: 30000,
      compression: true
    };

    const clickhouseClient = new MonadClickHouseClient(clickhouseConfig);
    const isClickHouseUp = await clickhouseClient.ping();
    
    if (isClickHouseUp) {
      console.log(`  ✅ Connection successful (${clickhouseConfig.host}:${clickhouseConfig.port})`);
      console.log(`  📊 Database: ${clickhouseConfig.database}`);
    } else {
      console.log(`  ❌ Cannot connect to ClickHouse (${clickhouseConfig.host}:${clickhouseConfig.port})`);
      allHealthy = false;
    }
    
    await clickhouseClient.close();
  } catch (error) {
    console.log(`  ❌ ClickHouse error: ${error}`);
    allHealthy = false;
  }

  // Test Redis connectivity
  console.log('\n🗃️  Redis Cache:');
  try {
    const { MonadRedisClient } = await import('../src/cache/redis-client');
    
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

    const redisClient = new MonadRedisClient(redisConfig);
    const isRedisUp = await redisClient.ping();
    
    if (isRedisUp) {
      console.log(`  ✅ Connection successful (${redisConfig.host}:${redisConfig.port})`);
      console.log(`  🗂️  Database: ${redisConfig.db}`);
    } else {
      console.log(`  ❌ Cannot connect to Redis (${redisConfig.host}:${redisConfig.port})`);
      allHealthy = false;
    }
    
    await redisClient.close();
  } catch (error) {
    console.log(`  ❌ Redis error: ${error}`);
    allHealthy = false;
  }

  // Check log files
  console.log('\n📄 Sample Log Files:');
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  
  const logFiles = [
    'examples/monad-bft.log',
    'examples/ledger-tail.log'
  ];

  logFiles.forEach(file => {
    const fullPath = join(process.cwd(), file);
    if (existsSync(fullPath)) {
      console.log(`  ✅ ${file} found`);
    } else {
      console.log(`  ❌ ${file} missing`);
      allHealthy = false;
    }
  });

  // Final status
  console.log('\n' + '='.repeat(50));
  if (allHealthy) {
    console.log('🎉 All systems healthy! Ready to start analytics.');
    console.log('\n💡 Next steps:');
    console.log('   1. docker-compose up -d clickhouse redis');
    console.log('   2. npm run schema:init');
    console.log('   3. npm run demo:process-logs');
    process.exit(0);
  } else {
    console.log('⚠️  Some issues detected. Please resolve before continuing.');
    console.log('\n💡 Common solutions:');
    console.log('   • Start infrastructure: docker-compose up -d');
    console.log('   • Check .env configuration');
    console.log('   • Verify log files are in examples/ directory');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  healthCheck().catch((error) => {
    console.error('❌ Health check failed:', error);
    process.exit(1);
  });
} 