// Monad Validator Analytics - Main Application Entry Point
import 'dotenv/config';
import { DataIngestionService, IngestionConfig } from './services/data-ingestion';
import { SystemdLogStream, SystemdLogStreamConfig } from './services/systemd-log-stream';
import { AnalyticsAPIServer } from './api/server';
import { logger } from './utils/logger';

async function main() {
  logger.info('🚀 Starting Monad Validator Analytics System');

  try {
    // Load configuration
    const config = loadConfiguration();
    
    // Initialize data ingestion service
    const ingestionService = new DataIngestionService(config);
    
    // Initialize systemd log stream for production
    let logStream: SystemdLogStream | null = null;
    if (process.env.NODE_ENV === 'production') {
      const streamConfig = loadSystemdStreamConfig();
      logStream = new SystemdLogStream(streamConfig, ingestionService);
    }
    
    // Initialize API server
    const apiServer = new AnalyticsAPIServer({
      port: parseInt(process.env.API_PORT || '3000'),
      enableCors: true,
      enableCompression: true,
      enableRateLimit: true
    }, ingestionService);
    
    // Setup graceful shutdown
    setupGracefulShutdown(ingestionService, apiServer, logStream);
    
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
    
    logger.info('✅ Monad Validator Analytics System started successfully');
    
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

function loadSystemdStreamConfig(): SystemdLogStreamConfig {
  return {
    serviceNames: [
      process.env.MONAD_BFT_SERVICE_NAME || 'monad-bft',
      process.env.MONAD_LEDGER_SERVICE_NAME || 'monad-ledger-tail'
    ],
    followMode: true, // Always follow in production
    sinceWhen: process.env.LOG_SINCE_WHEN || 'now', // Start from now by default
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
  logStream?: SystemdLogStream | null
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