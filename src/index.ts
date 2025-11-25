// Monad Validator Analytics - Main Application Entry Point
import 'dotenv/config';
import { ApplicationInitializer } from './startup/application-initializer';
import { DataIngestionService, IngestionConfig } from './services/data-ingestion';
import { SystemdLogStream, SystemdLogStreamConfig } from './services/systemd-log-stream';
import { AnalyticsAPIServer } from './api/server';
import { ServiceContainer } from './services/service-container';
import { logger } from './utils/logger';

async function main() {
  logger.info('🚀 Starting Monad Validator Analytics System');
  logger.info('⚠️  CRITICAL: System will validate all validators are in database before proceeding');

  try {
    // =============================================
    // PHASE 1: CONFIGURATION & SERVICE CONTAINER
    // =============================================
    
    logger.info('🔍 Phase 1: Loading configuration and initializing service container...');
    
    // Load configuration first
    const config = loadConfiguration();
    
    // Initialize service container with configuration
    const serviceContainer = ServiceContainer.getInstance({
      clickhouse: config.clickhouse,
      redis: config.redis
    });
    await serviceContainer.initialize();
    
    // =============================================
    // PHASE 2: CRITICAL STARTUP VALIDATION
    // =============================================
    
    logger.info('🔍 Phase 2: Starting critical application initialization...');
    
    // Initialize application with validator database validation (uses service container)
    const applicationInitializer = new ApplicationInitializer(ApplicationInitializer.createDefaultConfig());
    const startupResult = await applicationInitializer.initialize();
    
    if (!startupResult.success) {
      logger.error('❌ Application initialization failed');
      throw new Error(`Startup validation failed: ${startupResult.errors.join(', ')}`);
    }
    
    logger.info('✅ Critical startup validation completed successfully');
    logger.info(`📊 Database initialized with ${startupResult.validatorStats.totalValidators} validators (${startupResult.validatorStats.completionRate.toFixed(1)}% with location data)`);
    
    // =============================================
    // PHASE 3: APPLICATION SERVICES STARTUP
    // =============================================
    
    logger.info('🔧 Phase 3: Starting application services...');
    
    // Initialize data ingestion service (now uses service container internally)
    const ingestionService = new DataIngestionService(config);
    
    // Initialize systemd log stream for production
    let logStream: SystemdLogStream | null = null;
    if (process.env.NODE_ENV === 'production') {
      const clickhouseClient = serviceContainer.getClickHouseClient();
      const streamConfig = await loadSystemdStreamConfig(clickhouseClient);
      logStream = new SystemdLogStream(streamConfig, ingestionService);
    }
    
    // Initialize API server
    const apiServer = new AnalyticsAPIServer({
      port: parseInt(process.env.API_PORT || '3000'),
      enableCors: true,
      enableCompression: true,
      enableRateLimit: true
    }, ingestionService);
    
    // Setup graceful shutdown with application initializer
    setupGracefulShutdown(ingestionService, apiServer, logStream, applicationInitializer);
    
    // Start services
    await ingestionService.start();
    await apiServer.start();
    
    // Start log streaming based on environment
    if (process.env.NODE_ENV === 'production' && logStream) {
      logger.info('🔄 Starting real-time systemd log streaming...');
      await logStream.start();
      
      // Setup log stream event handlers
      setupLogStreamHandlers(logStream);
      
      logger.info('✅ Production systemd log streaming started');
    } else {
      // Demo: Process the provided log files in development
      logger.info('🔄 Processing demo log files...');
      await ingestionService.processLogFile('./examples/monad-bft.log');
      await ingestionService.processLogFile('./examples/ledger-tail.log');
      logger.info('✅ Demo log files processed');
    }
    
    logger.info('🎉 Monad Validator Analytics System started successfully');
    logger.info(`⚡ Total startup time: ${startupResult.timeMs + (Date.now() - Date.now())}ms`);
    logger.info('🔄 System is ready to process validator analytics with validated database');
    
  } catch (error) {
    logger.error('❌ Failed to start Monad Validator Analytics System:', error);
    logger.error('🚫 Startup failed - ensure ClickHouse is running and validator data is available');
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

async function loadSystemdStreamConfig(clickhouseClient: any): Promise<SystemdLogStreamConfig> {
  // Get last processed timestamp from block_proposals for backfill
  let sinceWhen = process.env.LOG_SINCE_WHEN || 'now';

  try {
    const result = await clickhouseClient.executeRawQuery(`
      SELECT max(timestamp) as last_ts FROM block_proposals
    `);

    if (result && result[0]?.last_ts) {
      // Format timestamp for journalctl (e.g., "2025-11-25 16:28:00")
      const lastTimestamp = new Date(result[0].last_ts);
      if (!isNaN(lastTimestamp.getTime())) {
        sinceWhen = lastTimestamp.toISOString().replace('T', ' ').substring(0, 19);
        logger.info(`📋 Log stream will start from last block_proposals timestamp: ${sinceWhen}`);
      }
    }
  } catch (error) {
    logger.warn('Could not get last block_proposals timestamp, starting from now:', error);
  }

  return {
    serviceNames: [
      process.env.MONAD_BFT_SERVICE_NAME || 'monad-bft',
      process.env.MONAD_LEDGER_SERVICE_NAME || 'monad-ledger-tail'
    ],
    followMode: true, // Always follow in production
    sinceWhen, // Dynamic: starts from last processed timestamp for backfill
    outputFormat: 'json', // JSON format for easier parsing
    priority: process.env.LOG_PRIORITY as any || 'info',
    bufferSize: parseInt(process.env.STREAM_BUFFER_SIZE || '100'),
    restartOnFailure: true,
    maxRestartAttempts: parseInt(process.env.STREAM_MAX_RESTART_ATTEMPTS || '5'),
    restartDelayMs: parseInt(process.env.STREAM_RESTART_DELAY_MS || '5000'),
    includeKernelMessages: false
  };
}

function setupLogStreamHandlers(logStream: SystemdLogStream): void {
  logStream.on('batchProcessed', (data) => {
    logger.debug(`Log stream batch processed: ${data.linesProcessed} lines`);
  });
  
  logStream.on('metricsUpdated', (metrics) => {
    logger.debug(`Log stream metrics - Lines/sec: ${metrics.linesPerSecond.toFixed(2)}, Buffer: ${metrics.bufferUsage.toFixed(1)}%`);
  });
  
  logStream.on('error', (error) => {
    logger.error('Log stream error:', error);
  });
  
  logStream.on('bufferError', ({ error, linesLost }) => {
    logger.error(`Log stream buffer error - lost ${linesLost} lines:`, error);
  });
}

function setupGracefulShutdown(
  ingestionService: DataIngestionService, 
  apiServer: AnalyticsAPIServer,
  logStream?: SystemdLogStream | null,
  applicationInitializer?: ApplicationInitializer
) {
  const gracefulShutdown = async (signal: string) => {
    logger.info(`🛑 Received ${signal}, starting graceful shutdown...`);
    
    try {
      // Stop accepting new requests
      await apiServer.stop();
      logger.info('✅ API server stopped');
      
      // Stop log streaming if running
      if (logStream) {
        await logStream.stop();
        logger.info('✅ Log stream stopped');
      }
      
      // Stop data ingestion service
      await ingestionService.stop();
      logger.info('✅ Data ingestion service stopped');
      
      // Cleanup application initializer resources (includes service container shutdown)
      if (applicationInitializer) {
        await applicationInitializer.shutdown();
        logger.info('✅ Application initializer cleaned up');
      }
      
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
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('❌ Unhandled Rejection at:', { promise: {}, reason: {}, stack: reason instanceof Error ? reason.stack : 'No stack trace' });
    console.error('❌ Unhandled Promise Rejection:', reason);
    // Don't exit the process, just log it
  });
}

// Start the application
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} 