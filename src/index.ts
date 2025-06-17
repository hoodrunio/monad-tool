// Monad Validator Analytics - Main Application Entry Point
import 'dotenv/config';
import { DataIngestionService, IngestionConfig } from './services/data-ingestion';
import { AnalyticsAPIServer } from './api/server';
import { logger } from './utils/logger';

async function main() {
  logger.info('🚀 Starting Monad Validator Analytics System');

  try {
    // Load configuration
    const config = loadConfiguration();
    
    // Initialize data ingestion service
    const ingestionService = new DataIngestionService(config);
    
    // Initialize API server
    const apiServer = new AnalyticsAPIServer({
      port: parseInt(process.env.API_PORT || '3000'),
      enableCors: true,
      enableCompression: true,
      enableRateLimit: true
    }, ingestionService);
    
    // Setup graceful shutdown
    setupGracefulShutdown(ingestionService, apiServer);
    
    // Start services
    await ingestionService.start();
    await apiServer.start();
    
    logger.info('✅ Monad Validator Analytics System started successfully');
    
    // Demo: Process the provided log files
    if (process.env.NODE_ENV === 'development') {
      logger.info('🔄 Processing demo log files...');
      await ingestionService.processLogFile('./examples/monad-bft.log');
      await ingestionService.processLogFile('./examples/ledger-tail.log');
      logger.info('✅ Demo log files processed');
    }
    
  } catch (error) {
    logger.error('❌ Failed to start Monad Validator Analytics System:', error);
    process.exit(1);
  }
}

function loadConfiguration(): IngestionConfig {
  return {
    clickhouse: {
      host: process.env.CLICKHOUSE_HOST || 'localhost',
      port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
      username: process.env.CLICKHOUSE_USERNAME || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
      max_open_connections: parseInt(process.env.CLICKHOUSE_MAX_CONNECTIONS || '10'),
      max_query_timeout: parseInt(process.env.CLICKHOUSE_QUERY_TIMEOUT || '30000'),
      compression: process.env.CLICKHOUSE_COMPRESSION === 'true'
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'monad:',
      maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES || '3'),
      retryDelayOnFailover: parseInt(process.env.REDIS_RETRY_DELAY || '1000'),
      maxMemoryPolicy: process.env.REDIS_MEMORY_POLICY || 'allkeys-lru',
      defaultTtl: parseInt(process.env.REDIS_DEFAULT_TTL || '300')
    },
    processing: {
      batchSize: parseInt(process.env.PROCESSING_BATCH_SIZE || '1000'),
      batchTimeoutMs: parseInt(process.env.PROCESSING_BATCH_TIMEOUT || '5000'),
      maxRetries: parseInt(process.env.PROCESSING_MAX_RETRIES || '3'),
      enableQCParsing: process.env.ENABLE_QC_PARSING !== 'false',
      enableVoteChainAnalysis: process.env.ENABLE_VOTE_CHAIN_ANALYSIS !== 'false',
      enableGeographicIntelligence: process.env.ENABLE_GEOGRAPHIC_INTELLIGENCE !== 'false',
      parallelProcessing: process.env.ENABLE_PARALLEL_PROCESSING !== 'false',
      maxConcurrentBatches: parseInt(process.env.MAX_CONCURRENT_BATCHES || '5')
    },
    ingestion: {
      batchSize: parseInt(process.env.INGESTION_BATCH_SIZE || '500'),
      batchTimeoutMs: parseInt(process.env.INGESTION_BATCH_TIMEOUT || '2000'),
      maxConcurrentBatches: parseInt(process.env.INGESTION_MAX_CONCURRENT_BATCHES || '3'),
      errorRetryAttempts: parseInt(process.env.INGESTION_ERROR_RETRY_ATTEMPTS || '2'),
      enableRealTimeUpdates: process.env.ENABLE_REAL_TIME_UPDATES !== 'false',
      enablePerformanceMonitoring: process.env.ENABLE_PERFORMANCE_MONITORING !== 'false'
    }
  };
}

function setupGracefulShutdown(ingestionService: DataIngestionService, apiServer: AnalyticsAPIServer) {
  const gracefulShutdown = async (signal: string) => {
    logger.info(`🛑 Received ${signal}, starting graceful shutdown...`);
    
    try {
      // Stop accepting new requests
      await apiServer.stop();
      logger.info('✅ API server stopped');
      
      // Stop data ingestion service
      await ingestionService.stop();
      logger.info('✅ Data ingestion service stopped');
      
      logger.info('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Error during graceful shutdown:', error);
      process.exit(1);
    }
  };
  
  // Handle shutdown signals
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  
  // Handle uncaught exceptions and unhandled rejections
  process.on('uncaughtException', (error) => {
    logger.error('❌ Uncaught Exception:', error);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}

// Start the application
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} 