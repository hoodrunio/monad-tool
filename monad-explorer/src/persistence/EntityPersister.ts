import { ProcessingResult } from '../processing/BlockProcessor';
import { logger } from '../utils/logger';
import { sanitizeEntityInPlace } from '../utils/data-sanitizer';
import { In } from 'typeorm';
import { IStorageRouter, StorageRoutingResult, HotStorageBatch, ColdStorageMessage, EntityBreakdown } from '../interfaces/storage/IStorageRouter';
import { IQueueService, QueueMessage } from '../interfaces/services/IQueueService';
import { serviceContainer } from '../services/core/ServiceContainer';
import { appConfig } from '../config/AppConfig';

/**
 * Entity Persister
 * Single Responsibility: Only handles database persistence operations
 */
export class EntityPersister {
  private storageRouterPromise?: Promise<IStorageRouter>;
  private queueServicePromise?: Promise<IQueueService | null>;
  private readonly config = appConfig.getConfig();

  constructor(private readonly container = serviceContainer) {}
  
  /**
   * Persist all processed entities to the database
   * ⚡ OPTIMIZED: Parallel + Chunked persistence for maximum performance
   */
  public async persistEntities(store: any, result: ProcessingResult): Promise<StorageRoutingResult> {
    const startTime = Date.now();
    const storageRouter = await this.getStorageRouter();
    const routing = storageRouter.route(result);
    
    logger.info('Starting optimized entity persistence', {
      routingMode: routing.metadata.routingMode,
      blocks: routing.hot.blocks.length,
      transactions: routing.hot.transactions.length,
      accounts: routing.hot.accounts.length,
      logs: routing.hot.logs.length,
      methodSignatures: routing.hot.methodSignatures.length,
      tokens: routing.hot.tokens.length,
      contracts: routing.hot.contracts.length,
      discoveredContracts: routing.hot.discoveredContracts.length,
    });

    try {
      // ⚡ PHASE 1: Sequential (FK dependencies) - Fast entities first
      await this.persistAccounts(store, routing.hot);
      await this.persistMethodSignatures(store, routing.hot);
      await this.persistBlocks(store, routing.hot);

      // ⚡ PHASE 2: Sequential for FK dependencies, Parallel within each
      await this.persistTransactionsChunked(store, routing.hot);
      
      // ⚡ PHASE 3: Parallel (No FK dependencies)
      await Promise.all([
        this.persistLogsChunked(store, routing.hot),
        this.persistTokensOptimized(store, routing.hot),
        this.persistContracts(store, routing.hot),
      ]);

      await this.enqueueColdStorageBatch(routing);

      const duration = Date.now() - startTime;
      logger.info('Optimized entity persistence completed', {
        duration,
        totalEntities: routing.metadata.hotEntityTotal,
        routingMode: routing.metadata.routingMode,
        latestBlockNumber: routing.metadata.latestBlockNumber,
        hotWindowStart: routing.metadata.hotWindowStart,
      });

      return routing;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Entity persistence failed', {
        duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist account entities
   */
  private async persistAccounts(store: any, batch: HotStorageBatch): Promise<void> {
    if (batch.accounts.length === 0) {
      return;
    }

    try {
      await store.upsert(batch.accounts);
      
      logger.debug('Accounts persisted successfully', { 
        count: batch.accounts.length 
      });
    } catch (error) {
      logger.error('Failed to persist accounts', {
        count: batch.accounts.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist method signature entities
   */
  private async persistMethodSignatures(store: any, batch: HotStorageBatch): Promise<void> {
    if (batch.methodSignatures.length === 0) {
      return;
    }

    try {
      await store.upsert(batch.methodSignatures);
      
      logger.debug('Method signatures persisted successfully', { 
        count: batch.methodSignatures.length 
      });
    } catch (error) {
      logger.error('Failed to persist method signatures', {
        count: batch.methodSignatures.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist block entities
   */
  private async persistBlocks(store: any, batch: HotStorageBatch): Promise<void> {
    if (batch.blocks.length === 0) {
      return;
    }

    try {
      await store.insert(batch.blocks);
      
      logger.debug('Blocks persisted successfully', { 
        count: batch.blocks.length,
        blockRange: `${batch.blocks[0]?.number}-${batch.blocks[batch.blocks.length - 1]?.number}`,
      });
    } catch (error) {
      logger.error('Failed to persist blocks', {
        count: batch.blocks.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist transaction entities (legacy method)
   */
  private async persistTransactions(store: any, batch: HotStorageBatch): Promise<void> {
    await this.persistTransactionsChunked(store, batch);
  }

  /**
   * ⚡ OPTIMIZED: Chunked transaction persistence for large datasets
   */
  private async persistTransactionsChunked(store: any, batch: HotStorageBatch): Promise<void> {
    if (batch.transactions.length === 0) {
      return;
    }

    try {
      const CHUNK_SIZE = 20000; // Process 20000 transactions per chunk
      const chunks = this.chunkArray(batch.transactions, CHUNK_SIZE);
      
      // Bulk sanitize all transactions first
      this.bulkSanitize(batch.transactions);
      
      // Process chunks in parallel (with concurrency limit)
      await this.processChunksInParallel(chunks, async (chunk, index) => {
        await store.insert(chunk);
        logger.debug(`Transaction chunk ${index + 1}/${chunks.length} persisted`, { 
          count: chunk.length 
        });
      }, 3); // Max 3 concurrent chunks
      
      logger.info('All transactions persisted successfully', { 
        totalCount: batch.transactions.length,
        chunks: chunks.length 
      });
    } catch (error) {
      logger.error('Failed to persist transactions', {
        count: batch.transactions.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist log entities (legacy method)
   */
  private async persistLogs(store: any, batch: HotStorageBatch): Promise<void> {
    await this.persistLogsChunked(store, batch);
  }

  /**
   * ⚡ OPTIMIZED: Chunked logs persistence for large datasets
   */
  private async persistLogsChunked(store: any, batch: HotStorageBatch): Promise<void> {
    if (batch.logs.length === 0) {
      return;
    }

    try {
      const CHUNK_SIZE = 20000; // Process 20000 logs per chunk
      const chunks = this.chunkArray(batch.logs, CHUNK_SIZE);
      
      // Bulk sanitize all logs first
      this.bulkSanitize(batch.logs);
      
      // Process chunks in parallel
      await this.processChunksInParallel(chunks, async (chunk: any[], index: number) => {
        await store.insert(chunk);
        logger.debug(`Log chunk ${index + 1}/${chunks.length} persisted`, { 
          count: chunk.length 
        });
      }, 3); // Max 3 concurrent chunks
      
      logger.info('All logs persisted successfully', { 
        totalCount: batch.logs.length,
        chunks: chunks.length 
      });
    } catch (error) {
      logger.error('Failed to persist logs', {
        count: batch.logs.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist token entities (legacy method)
   */
  private async persistTokens(store: any, batch: HotStorageBatch): Promise<void> {
    await this.persistTokensOptimized(store, batch);
  }

  /**
   * ⚡ OPTIMIZED: Simplified token persistence without expensive existence checks
   */
  private async persistTokensOptimized(store: any, batch: HotStorageBatch): Promise<void> {
    if (batch.tokens.length === 0) {
      return;
    }

    try {
      // Simple upsert approach - let database handle duplicates
      await store.upsert(batch.tokens);
      
      logger.info('Tokens persisted successfully', { 
        count: batch.tokens.length
      });
      
    } catch (error) {
      logger.error('Failed to persist tokens', {
        count: batch.tokens.length,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Persist contract entities (both creation and discovered contracts)
   * SMART PERSISTENCE: Check existing contracts first, insert only new ones
   */
  private async persistContracts(store: any, batch: HotStorageBatch): Promise<void> {
    // Combine both regular contracts and discovered contracts
    const allContracts = [...batch.contracts, ...batch.discoveredContracts];
    
    if (allContracts.length === 0) {
      return;
    }

    try {
      // Check which contracts already exist in database
      const contractAddresses = allContracts.map(c => c.address.toLowerCase());
      
      const existingContracts = await store.find('Contract', {
        where: { 
          address: In(contractAddresses)
        }
      });
      
      const existingAddresses = new Set(existingContracts.map((c: any) => c.address.toLowerCase()));
      
      logger.debug('Database contract existence check completed', {
        creationContracts: batch.contracts.length,
        discoveredContracts: batch.discoveredContracts.length,
        totalRequested: allContracts.length,
        existingInDb: existingAddresses.size,
        newToInsert: allContracts.length - existingAddresses.size,
      });

      // Insert only NEW contracts (those not in database)
      const newContracts = allContracts.filter(c => !existingAddresses.has(c.address.toLowerCase()));
      
      if (newContracts.length > 0) {
        // Separate creation and discovered contracts for logging
        const newCreationContracts = newContracts.filter(c => 
          batch.contracts.some(rc => rc.address === c.address)
        );
        const newDiscoveredContracts = newContracts.filter(c => 
          batch.discoveredContracts.some(dc => dc.address === c.address)
        );
        
        logger.debug('Inserting new contracts', {
          total: newContracts.length,
          creation: newCreationContracts.length,
          discovered: newDiscoveredContracts.length,
          addresses: newContracts.map(c => c.address)
        });
        
        await store.insert(newContracts);
        
        logger.debug('✅ New contracts inserted successfully', { 
          total: newContracts.length,
          creation: newCreationContracts.length,
          discovered: newDiscoveredContracts.length,
        });
      }

      logger.debug('✅ Contract persistence completed successfully', { 
        totalContracts: allContracts.length,
        creationContracts: batch.contracts.length,
        discoveredContracts: batch.discoveredContracts.length,
        existingInDb: existingAddresses.size,
        inserted: newContracts.length,
      });
      
    } catch (error) {
      logger.error('❌ Failed to persist contracts', {
        totalContracts: allContracts.length,
        creationContracts: batch.contracts.length,
        discoveredContracts: batch.discoveredContracts.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async enqueueColdStorageBatch(routing: StorageRoutingResult): Promise<void> {
    if (!routing.cold) {
      return;
    }

    const queueService = await this.getQueueService();
    if (!queueService) {
      logger.warn('Cold storage batch not enqueued - queue service unavailable', {
        batchId: routing.cold.batchId,
      });
      return;
    }

    if (!queueService.isConnected()) {
      logger.warn('Cold storage batch not enqueued - queue service not connected', {
        batchId: routing.cold.batchId,
      });
      return;
    }

    const message = this.buildColdStorageMessage(routing);
    const queueMessage: QueueMessage<ColdStorageMessage> = {
      type: 'COLD_STORAGE_BATCH',
      data: message,
      priority: 6,
      retryCount: 0,
      timestamp: Date.now(),
      messageId: `COLD_STORAGE_BATCH-${routing.cold.batchId}`,
    };

    try {
      await queueService.publish(this.config.storage.coldQueue, queueMessage, {
        persistent: true,
        priority: 6,
      });

      logger.debug('Cold storage batch enqueued', {
        batchId: routing.cold.batchId,
        routingMode: routing.metadata.routingMode,
        coldEntityTotal: routing.metadata.coldEntityTotal,
      });
    } catch (error) {
      logger.error('Failed to enqueue cold storage batch', {
        batchId: routing.cold.batchId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private buildColdStorageMessage(routing: StorageRoutingResult): ColdStorageMessage {
    const coldBatch = routing.cold;
    if (!coldBatch) {
      throw new Error('Cold batch is not available for message construction');
    }

    const entityCounts = routing.metadata.coldBreakdown ?? routing.metadata.hotBreakdown;

    return {
      version: 1,
      payload: coldBatch,
      routingMode: routing.metadata.routingMode,
      hotBlockWindow: this.config.storage.hotBlockWindow,
      entityCounts,
    };
  }

  private async getStorageRouter(): Promise<IStorageRouter> {
    if (!this.storageRouterPromise) {
      this.storageRouterPromise = this.container.resolve<IStorageRouter>('storageRouter');
    }

    return this.storageRouterPromise;
  }

  private async getQueueService(): Promise<IQueueService | null> {
    if (!this.config.storage.enableColdStorage) {
      return null;
    }

    if (!this.queueServicePromise) {
      this.queueServicePromise = (async () => {
        try {
          const service = await this.container.resolve<IQueueService>('queueService');
          return service;
        } catch (error) {
          logger.warn('Unable to resolve queue service for cold storage routing', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          return null;
        }
      })();
    }

    return this.queueServicePromise;
  }

  // ⚡ UTILITY METHODS FOR OPTIMIZED PERSISTENCE

  /**
   * Split array into chunks of specified size
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Bulk sanitize entities in place (much faster than individual sanitization)
   */
  private bulkSanitize(entities: any[]): void {
    entities.forEach(entity => sanitizeEntityInPlace(entity));
  }

  /**
   * Process chunks in parallel with concurrency limit
   */
  private async processChunksInParallel<T>(
    chunks: T[][],
    processor: (chunk: T[], index: number) => Promise<void>,
    maxConcurrency: number
  ): Promise<void> {
    const processingPromises: Promise<void>[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const promise = processor(chunks[i], i);
      processingPromises.push(promise);
      
      // Control concurrency
      if (processingPromises.length >= maxConcurrency) {
        await Promise.race(processingPromises);
        // Remove completed promises
        for (let j = processingPromises.length - 1; j >= 0; j--) {
          const p = processingPromises[j];
          if (await Promise.race([p, Promise.resolve('pending')]) !== 'pending') {
            processingPromises.splice(j, 1);
          }
        }
      }
    }
    
    // Wait for all remaining promises
    await Promise.all(processingPromises);
  }

  // ✅ TokenTransfer persistence removed - now computed at runtime from logs

  /**
   * Get persistence statistics
   */
  public getPersistenceStats(routing: StorageRoutingResult): {
    hot: {
      totalEntities: number;
      entityBreakdown: EntityBreakdown;
    };
    cold?: {
      totalEntities: number;
      entityBreakdown: EntityBreakdown;
      batchId: string;
    };
  } {
    const stats: {
      hot: {
        totalEntities: number;
        entityBreakdown: EntityBreakdown;
      };
      cold?: {
        totalEntities: number;
        entityBreakdown: EntityBreakdown;
        batchId: string;
      };
    } = {
      hot: {
        totalEntities: routing.metadata.hotEntityTotal,
        entityBreakdown: routing.metadata.hotBreakdown,
      },
    };

    if (routing.cold && routing.metadata.coldBreakdown) {
      stats.cold = {
        totalEntities: routing.metadata.coldEntityTotal,
        entityBreakdown: routing.metadata.coldBreakdown,
        batchId: routing.cold.batchId,
      };
    }

    return stats;
  }
}
