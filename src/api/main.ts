// Monad Validator Analytics - Main API Application Entry Point
import dotenv from 'dotenv';
import { AnalyticsAPIServer, APIServerConfig } from './server';
import { DataIngestionService } from '../services/data-ingestion';
import { MonadClickHouseClient } from '../database/clickhouse-client';
import { MonadRedisClient } from '../cache/redis-client';
import { logger } from '../utils/logger';

// Load environment variables
dotenv.config();

// =============================================
// API APPLICATION CLASS
// =============================================

export class MonadAnalyticsAPI {
  private apiServer: AnalyticsAPIServer | null = null;
  private ingestionService: DataIngestionService | null = null;
  
  constructor() {
    // Set up graceful shutdown handlers
    process.on('SIGINT', this.handleShutdown.bind(this));
    process.on('SIGTERM', this.handleShutdown.bind(this));
    process.on('uncaughtException', this.handleUncaughtException.bind(this));
    process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize(): Promise<void> {
    try {
      logger.info('🚀 Starting Monad Validator Analytics API...');
      
      // Initialize data ingestion service
      await this.initializeDataIngestion();
      
      // Initialize API server
      await this.initializeAPIServer();
      
      logger.info('✅ Monad Validator Analytics API initialization complete');
    } catch (error) {
      logger.error('❌ Failed to initialize API application:', error);
      throw error;
    }
  }

  private async initializeDataIngestion(): Promise<void> {
    logger.info('📊 Initializing data ingestion service...');
    
    // Create configuration object for data ingestion service
    const config = {
      clickhouse: {
        host: process.env.CLICKHOUSE_HOST || 'localhost',
        port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
        username: process.env.CLICKHOUSE_USERNAME || 'default',
        password: process.env.CLICKHOUSE_PASSWORD || '',
        database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
        max_open_connections: 10,
        max_query_timeout: 30000,
        compression: true
      },
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'monad:',
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 1000,
        maxMemoryPolicy: 'allkeys-lru',
        defaultTtl: 300
      },
      processing: {
        batchSize: 1000,
        batchTimeoutMs: 5000,
        maxRetries: 3,
        enableQCParsing: true,
        enableVoteChainAnalysis: true,
        enableGeographicIntelligence: true,
        parallelProcessing: true,
        maxConcurrentBatches: 3
      },
      ingestion: {
        batchSize: parseInt(process.env.BATCH_SIZE || '100'),
        batchTimeoutMs: parseInt(process.env.BATCH_TIMEOUT_MS || '5000'),
        maxConcurrentBatches: parseInt(process.env.MAX_CONCURRENT_BATCHES || '3'),
        errorRetryAttempts: parseInt(process.env.ERROR_RETRY_ATTEMPTS || '3'),
        enableRealTimeUpdates: process.env.ENABLE_REAL_TIME_UPDATES !== 'false',
        enablePerformanceMonitoring: process.env.ENABLE_PERFORMANCE_MONITORING !== 'false'
      }
    };

    // Initialize data ingestion service
    this.ingestionService = new DataIngestionService(config);
    await this.ingestionService.start();
    
    logger.info('✅ Data ingestion service initialized');
  }

  private async initializeAPIServer(): Promise<void> {
    if (!this.ingestionService) {
      throw new Error('Data ingestion service must be initialized first');
    }

    logger.info('🌐 Initializing API server...');
    
    // Get API server configuration from environment
    const config: APIServerConfig = {
      port: parseInt(process.env.API_PORT || '3000'),
      enableCors: process.env.ENABLE_CORS !== 'false',
      enableCompression: process.env.ENABLE_COMPRESSION !== 'false',
      enableRateLimit: process.env.ENABLE_RATE_LIMIT !== 'false'
    };

    // Create and start API server
    this.apiServer = new AnalyticsAPIServer(config, this.ingestionService);
    await this.apiServer.start();
    
    logger.info('✅ API server initialized');
  }

  // =============================================
  // STARTUP CHECKS
  // =============================================

  async performStartupChecks(): Promise<void> {
    logger.info('🔍 Performing startup health checks...');
    
    if (!this.ingestionService) {
      throw new Error('Data ingestion service not initialized');
    }

    // Check system health
    const health = await this.ingestionService.getSystemHealth();
    
    if (!health.database) {
      throw new Error('ClickHouse database is not healthy');
    }
    
    if (!health.cache) {
      throw new Error('Redis cache is not healthy');
    }
    
    logger.info('✅ All startup health checks passed');
    
    // Log system metrics
    const metrics = this.ingestionService.getMetrics();
    logger.info('📈 System metrics:', {
      totalLogsProcessed: metrics.totalLogsProcessed,
      failedBatches: metrics.failedBatches,
      logsPerSecond: metrics.logsPerSecond,
      errorRate: metrics.errorRate,
      uptime: process.uptime()
    });
  }

  // =============================================
  // ENDPOINT TESTING
  // =============================================

  async testEndpoints(): Promise<void> {
    const port = process.env.API_PORT || '4000';
    const baseUrl = `http://localhost:${port}`;
    
    logger.info('🧪 Testing API endpoints...');

    const endpoints = [
      '/health',
      '/api/system/health',
      '/api/system/metrics',
      '/api/network/summary',
      '/api/events/types',
      '/api/validators/rankings?limit=10'
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`${baseUrl}${endpoint}`);
        const status = response.ok ? '✅' : '❌';
        logger.info(`${status} ${endpoint} - ${response.status}`);
      } catch (error) {
        logger.warn(`⚠️  ${endpoint} - Error: ${error}`);
      }
    }
  }

  // =============================================
  // SHUTDOWN HANDLING
  // =============================================

  private async handleShutdown(signal: string): Promise<void> {
    logger.info(`🛑 Received ${signal}, initiating graceful shutdown...`);
    
    try {
      // Stop API server
      if (this.apiServer) {
        await this.apiServer.stop();
        logger.info('✅ API server stopped');
      }
      
      // Stop data ingestion service
      if (this.ingestionService) {
        await this.ingestionService.stop();
        logger.info('✅ Data ingestion service stopped');
      }
      
      logger.info('✅ Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  }

  private handleUncaughtException(error: Error): void {
    logger.error('❌ Uncaught Exception:', error);
    this.handleShutdown('UNCAUGHT_EXCEPTION');
  }

  private handleUnhandledRejection(reason: any, promise: Promise<any>): void {
    logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    this.handleShutdown('UNHANDLED_REJECTION');
  }
}

// =============================================
// MAIN FUNCTION
// =============================================

async function main(): Promise<void> {
  const app = new MonadAnalyticsAPI();
  
  try {
    // Initialize the application
    await app.initialize();
    
    // Perform startup checks
    await app.performStartupChecks();
    
    // Test endpoints (optional)
    if (process.env.TEST_ENDPOINTS === 'true') {
      // Wait a moment for server to be ready
      setTimeout(() => app.testEndpoints(), 2000);
    }
    
    logger.info('🎉 Monad Validator Analytics API is ready!');
    logger.info(`📊 Visit http://localhost:${process.env.API_PORT || '3000'}/health for status`);
    
  } catch (error) {
    logger.error('❌ Failed to start API application:', error);
    process.exit(1);
  }
}

// Start the application if this file is run directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main }; 