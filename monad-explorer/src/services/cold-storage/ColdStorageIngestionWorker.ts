import { logger } from '../../utils/logger';
import { serviceContainer } from '../core/ServiceContainer';
import { IQueueService } from '../../interfaces/services/IQueueService';
import { ColdStorageMessage } from '../../interfaces/storage/IStorageRouter';
import { ClickHouseService } from './ClickHouseService';
import { appConfig } from '../../config/AppConfig';

export class ColdStorageIngestionWorker {
  private clickHouseService!: ClickHouseService;
  private queueService!: IQueueService;
  private isRunning = false;
  private processedBatches = 0;
  private failedBatches = 0;

  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('ColdStorageIngestionWorker already running');
      return;
    }

    await this.initialize();

    this.isRunning = true;

    const storageConfig = appConfig.getConfig().storage;

    await this.queueService.consumeColdStorage(
      this.handleMessage.bind(this),
      {
        concurrency: storageConfig.ingestion.workerConcurrency,
        prefetch: storageConfig.ingestion.queuePrefetch,
        autoAck: false,
      }
    );

    logger.info('ColdStorageIngestionWorker started', {
      concurrency: storageConfig.ingestion.workerConcurrency,
      prefetch: storageConfig.ingestion.queuePrefetch,
    });
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    try {
      await this.clickHouseService.close();
      logger.info('ColdStorageIngestionWorker stopped', {
        processedBatches: this.processedBatches,
        failedBatches: this.failedBatches,
      });
    } catch (error) {
      logger.error('Error stopping ColdStorageIngestionWorker', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async initialize(): Promise<void> {
    const config = appConfig.getConfig();

    if (!config.storage.enableColdStorage) {
      throw new Error('Cold storage is disabled - set ENABLE_COLD_STORAGE=true to start the worker');
    }

    this.queueService = await serviceContainer.resolve<IQueueService>('queueService');

    if (!this.queueService.isConnected()) {
      logger.info('Queue service not connected, connecting...');
      await this.queueService.connect();
    }

    if (!this.queueService.isConnected()) {
      throw new Error('Queue service is not connected to RabbitMQ');
    }

    this.clickHouseService = await serviceContainer.resolve<ClickHouseService>('clickHouseService');

    await this.clickHouseService.ping();

    logger.info('ColdStorageIngestionWorker initialization complete', {
      clickHouseHost: config.storage.clickHouse.url,
      clickHouseDatabase: config.storage.clickHouse.database,
      queue: config.storage.coldQueue,
    });
  }

  private async handleMessage(message: ColdStorageMessage): Promise<void> {
    if (!message || !message.payload) {
      logger.warn('Received malformed cold storage message');
      return;
    }

    const startTime = Date.now();

    try {
      if (message.version !== 1) {
        logger.warn('Processing cold storage message with unexpected version', {
          version: message.version,
        });
      }

      await this.clickHouseService.insertBatch(message.payload);
      this.processedBatches += 1;

      logger.debug('Cold storage batch ingested successfully', {
        batchId: message.payload.batchId,
        routingMode: message.routingMode,
        coldEntityCount: message.entityCounts.logs + message.entityCounts.transactions + message.entityCounts.blocks,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      this.failedBatches += 1;
      logger.error('Failed to ingest cold storage batch', {
        batchId: message.payload.batchId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
}
