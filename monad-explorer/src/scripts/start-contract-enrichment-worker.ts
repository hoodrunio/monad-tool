import 'dotenv/config';
import { ApplicationBootstrapper } from '../bootstrap/ApplicationBootstrapper';
import { serviceContainer } from '../services/core/ServiceContainer';
import { ContractEnrichmentWorker } from '../services/contract/ContractEnrichmentWorker';
import { appConfig } from '../config/AppConfig';
import { logger } from '../utils/logger';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { IQueueService } from '../interfaces/services/IQueueService';
import { IContractMetadataFetcher } from '../interfaces/services/IContractMetadataFetcher';

/**
 * Contract Enrichment Background Worker
 * 
 * This script starts a dedicated worker process that consumes contract enrichment
 * messages from RabbitMQ and enriches contracts with metadata in the background.
 * 
 * Usage:
 *   npm run worker:contract:dev
 */

class ContractEnrichmentWorkerApp {
  private worker?: ContractEnrichmentWorker;
  private bootstrapper: ApplicationBootstrapper;
  private dataSource?: DataSource;
  private isShuttingDown = false;

  constructor() {
    this.bootstrapper = new ApplicationBootstrapper();
  }

  /**
   * Start the worker application
   */
  public async start(): Promise<void> {
    try {
      logger.info('🚀 Starting Contract Enrichment Worker...');

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

      // Initialize database connection
      await this.initializeDatabase();

      // Resolve dependencies
      const queueService = await serviceContainer.resolve<IQueueService>('queueService');
      const contractMetadataFetcher = await serviceContainer.resolve<IContractMetadataFetcher>('contractMetadataFetcher');

      if (!queueService.isConnected()) {
        throw new Error('Queue service is not connected');
      }

      // Create and start worker
      this.worker = new ContractEnrichmentWorker(
        queueService,
        contractMetadataFetcher,
        this.dataSource!
      );

      await this.worker.start();

      logger.info('✅ Contract Enrichment Worker started successfully');

      // Setup graceful shutdown
      this.setupShutdownHandlers();

      // Start health monitoring
      this.startHealthMonitoring();

    } catch (error) {
      logger.error('Failed to start contract enrichment worker', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      process.exit(1);
    }
  }

  private async initializeDatabase(): Promise<void> {
    try {
      this.dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        username: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASS || 'postgres',
        database: process.env.DB_NAME || 'squid',
        synchronize: false,
        logging: false,
        namingStrategy: new SnakeNamingStrategy(),
        entities: [
          'lib/model/generated/*.js'
        ],
        migrations: ['lib/db/migrations/*.js'],
      });

      await this.dataSource.initialize();
      logger.info('✅ Database connection initialized for worker', {
        database: this.dataSource.options.database,
        host: (this.dataSource.options as any).host,
        entities: this.dataSource.entityMetadatas.length
      });

    } catch (error) {
      logger.error('❌ Failed to initialize database connection', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        if (this.worker) {
          await this.worker.stop();
        }

        if (this.dataSource?.isInitialized) {
          await this.dataSource.destroy();
        }

        await this.bootstrapper.shutdown();
        
        logger.info('Contract enrichment worker shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  private startHealthMonitoring(): void {
    const healthCheckInterval = 60000; // 1 minute

    setInterval(() => {
      if (this.worker && !this.isShuttingDown) {
        const stats = this.worker.getStats();
        logger.info('📊 Worker Statistics', {
          isRunning: stats.isRunning,
          processedCount: stats.processedCount,
          errorCount: stats.errorCount,
          uptime: `${Math.round(stats.uptime / 1000)}s`,
          processingRate: `${stats.processingRate.toFixed(2)}/s`
        });
      }
    }, healthCheckInterval);
  }
}

// Start the application
const app = new ContractEnrichmentWorkerApp();
app.start().catch((error) => {
  logger.error('Application failed to start', {
    error: error instanceof Error ? error.message : 'Unknown error'
  });
  process.exit(1);
}); 