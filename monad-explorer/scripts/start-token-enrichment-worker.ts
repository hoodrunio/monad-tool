import 'dotenv/config';
import { ApplicationBootstrapper } from '../src/bootstrap/ApplicationBootstrapper';
import { serviceContainer } from '../src/services/core/ServiceContainer';
import { TokenEnrichmentWorker } from '../src/services/token/TokenEnrichmentWorker';
import { appConfig } from '../src/config/AppConfig';
import { logger } from '../src/utils/logger';
import { DataSource } from 'typeorm';

/**
 * Token Enrichment Background Worker
 * 
 * This script starts a dedicated worker process that consumes token enrichment
 * messages from RabbitMQ and fetches metadata for tokens in the background.
 * 
 * Usage:
 *   npm run worker:token-enrichment
 *   # or with custom config
 *   WORKER_CONCURRENCY=5 WORKER_BATCH_SIZE=20 npm run worker:token-enrichment
 */

class TokenEnrichmentWorkerApp {
  private worker?: TokenEnrichmentWorker;
  private bootstrapper: ApplicationBootstrapper;
  private isShuttingDown = false;

  constructor() {
    this.bootstrapper = new ApplicationBootstrapper();
  }

  /**
   * Start the worker application
   */
  public async start(): Promise<void> {
    try {
      logger.info('🚀 Starting Token Enrichment Worker...');

      // Initialize application services
      await this.bootstrapper.initialize();

      // Check configuration
      const config = appConfig.getConfig();
      if (!config.processor.enableAsyncProcessing) {
        throw new Error('Async processing is disabled - set ENABLE_ASYNC_PROCESSING=true');
      }

      if (!config.queue.rabbitMqUrl) {
        throw new Error('RabbitMQ URL is not configured - set RABBITMQ_URL');
      }

      // Resolve dependencies
      const queueService = await serviceContainer.resolve<any>('queueService');
      const metadataFetcher = await serviceContainer.resolve<any>('tokenMetadataFetcher');
      const tokenRepository = await serviceContainer.resolve<any>('tokenRepository');

      // Get database connection (TypeORM DataSource)
      // For Squid framework, we need to access the database through the processor context
      // Since we're in a separate worker, we'll create our own connection
      const dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5433'), // 5432 yerine 5433 yapın
        username: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASS || 'postgres',
        database: process.env.DB_NAME || 'squid',
        entities: [
          // Use compiled JavaScript paths for production
          'lib/model/generated/*.js',
          'lib/model/index.js',
          // Also try TypeScript paths for development
          'src/model/generated/*.ts',
          'src/model/index.ts'
        ],
        synchronize: false,
        //logging: process.env.NODE_ENV === 'development',
        logging: false,
      });

      // Initialize the database connection
      if (!dataSource.isInitialized) {
        await dataSource.initialize();
        logger.info('✅ Database connection initialized for worker', {
          database: dataSource.options.database,
          host: 'host' in dataSource.options ? dataSource.options.host : 'N/A',
          entitiesCount: dataSource.entityMetadatas.length,
          entities: dataSource.entityMetadatas.map(meta => meta.name),
        });
      }

      // Check queue connection
      if (!queueService.isConnected()) {
        throw new Error('Queue service is not connected to RabbitMQ');
      }

      // Create worker configuration from environment
      const workerConfig = {
        concurrency: parseInt(process.env.WORKER_CONCURRENCY || '3'),
        retryAttempts: parseInt(process.env.WORKER_RETRY_ATTEMPTS || '3'),
        retryDelay: parseInt(process.env.WORKER_RETRY_DELAY || '1000'),
        batchSize: parseInt(process.env.WORKER_BATCH_SIZE || '10'),
        processingTimeout: parseInt(process.env.WORKER_PROCESSING_TIMEOUT || '30000'),
      };

      // Create and start worker
      this.worker = new TokenEnrichmentWorker(
        queueService,
        metadataFetcher,
        tokenRepository,
        dataSource,
        workerConfig
      );

      await this.worker.start();

      // Setup periodic stats logging
      this.setupStatsLogging();

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      logger.info('✅ Token Enrichment Worker started successfully', {
        config: workerConfig,
        queueConnection: await queueService.getHealthStatus(),
      });

      // Keep the process alive
      await this.keepAlive();

    } catch (error) {
      logger.error('❌ Failed to start Token Enrichment Worker', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      process.exit(1);
    }
  }

  /**
   * Stop the worker gracefully
   */
  public async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    logger.info('🛑 Stopping Token Enrichment Worker...');

    try {
      if (this.worker) {
        await this.worker.stop();
      }

      await this.bootstrapper.shutdown();

      logger.info('✅ Token Enrichment Worker stopped successfully');
    } catch (error) {
      logger.error('❌ Error during worker shutdown', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Setup periodic stats logging
   */
  private setupStatsLogging(): void {
    const logInterval = parseInt(process.env.STATS_LOG_INTERVAL || '60000'); // 1 minute

    setInterval(() => {
      if (this.worker && !this.isShuttingDown) {
        const stats = this.worker.getStats();
        logger.info('📊 Worker Statistics', {
          ...stats,
          uptime: `${Math.round(stats.uptime / 1000)}s`,
          processingRate: `${stats.processingRate.toFixed(2)} tokens/sec`,
        });
      }
    }, logInterval);
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const;

    signals.forEach(signal => {
      process.on(signal, async () => {
        logger.info(`Received ${signal}, initiating graceful shutdown...`);
        await this.stop();
        process.exit(0);
      });
    });

    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception detected', {
        error: error.message,
        stack: error.stack,
      });
      await this.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      logger.error('Unhandled promise rejection detected', {
        reason: reason instanceof Error ? reason.message : String(reason),
      });
      await this.stop();
      process.exit(1);
    });
  }

  /**
   * Keep the process alive
   */
  private async keepAlive(): Promise<void> {
    return new Promise((resolve) => {
      // The process will be kept alive by the queue consumer
      // This function completes when shutdown is initiated
      const checkShutdown = () => {
        if (this.isShuttingDown) {
          resolve();
        } else {
          setTimeout(checkShutdown, 1000);
        }
      };
      checkShutdown();
    });
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const app = new TokenEnrichmentWorkerApp();

  try {
    await app.start();
  } catch (error) {
    logger.error('Application failed to start', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  }
}

// Start the worker
main().catch((error) => {
  logger.error('Unhandled error in main', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exit(1);
}); 