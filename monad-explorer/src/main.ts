import { TypeormDatabase } from '@subsquid/typeorm-store';
import { processor } from './processor';
import { serviceContainer } from './services/core/ServiceContainer';
import { appConfig } from './config/AppConfig';
import { ApplicationBootstrapper } from './bootstrap/ApplicationBootstrapper';
import { BlockProcessor } from './processing/BlockProcessor';
import { EntityPersister } from './persistence/EntityPersister';
import { logger } from './utils/logger';

/**
 * Main Application Runner
 * Single Responsibility: Only orchestrates application execution
 */
class MainApplication {
  private readonly bootstrapper: ApplicationBootstrapper;
  private readonly blockProcessor: BlockProcessor;
  private readonly entityPersister: EntityPersister;

  constructor() {
    this.bootstrapper = new ApplicationBootstrapper();
    this.blockProcessor = new BlockProcessor(serviceContainer);
    this.entityPersister = new EntityPersister();
  }

  /**
   * Start the application
   */
  public async start(): Promise<void> {
    try {
      // Initialize application
      await this.bootstrapper.initialize();

      // Get configuration
      const config = appConfig.getConfig();

      // Create database with configuration
      const database = new TypeormDatabase({ 
        supportHotBlocks: config.database.supportHotBlocks 
      });

      // Start the Subsquid processor
      processor.run(database, async (ctx) => {
        // Check if application is shutting down
        if (this.bootstrapper.isShutdownInProgress) {
          logger.warn('Shutdown in progress, skipping block processing');
          return;
        }

        await this.processBlocks(ctx);
      });

    } catch (error) {
      logger.error('Application failed to start', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      process.exit(1);
    }
  }

  /**
   * Process blocks using the modular architecture
   */
  private async processBlocks(ctx: any): Promise<void> {
    const startTime = Date.now();
    const blockCount = ctx.blocks.length;
    const startBlock = ctx.blocks.at(0)?.header.height;
    const endBlock = ctx.blocks.at(-1)?.header.height;

    logger.info('Processing block batch', {
      startBlock,
      endBlock,
      blockCount
    });

    try {
      // Process blocks using dedicated processor
      const result = await this.blockProcessor.processBlocks(ctx.blocks, ctx.store);

      // Persist entities using dedicated persister
      const routing = await this.entityPersister.persistEntities(ctx.store, result);

      // Log success metrics
      const duration = Date.now() - startTime;
      const stats = this.entityPersister.getPersistenceStats(routing);
      
      logger.info('Block batch processed successfully', {
        startBlock,
        endBlock,
        blockCount,
        duration,
        routingMode: routing.metadata.routingMode,
        hotEntities: stats.hot.totalEntities,
        coldEntities: stats.cold?.totalEntities || 0,
        hotBreakdown: stats.hot.entityBreakdown,
        coldBreakdown: stats.cold?.entityBreakdown,
      });

      // Log processing summary to context logger
      const coldSummary = stats.cold ? `, ${stats.cold.totalEntities} cold entities` : '';
      ctx.log.info(`Processed blocks ${startBlock} to ${endBlock}: ${blockCount} blocks, ${stats.hot.totalEntities} hot entities${coldSummary}`);

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Block processing failed', {
        startBlock,
        endBlock,
        blockCount,
        duration,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
}

/**
 * Application entry point
 */
async function main(): Promise<void> {
  const app = new MainApplication();
  
  try {
    await app.start();
  } catch (error) {
    logger.error('Application failed to start', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  logger.error('Unhandled error in main', {
    error: error instanceof Error ? error.message : 'Unknown error'
  });
  process.exit(1);
});

