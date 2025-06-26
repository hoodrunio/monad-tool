import { DataSource, EntityManager } from 'typeorm';
import { Store } from '@subsquid/typeorm-store';
import { RabbitMQService, TokenEnrichmentMessage } from './queue/RabbitMQService';
import { TokenService } from './TokenService';
import { Token } from '../model';
import { logger } from '../utils/logger';
import axios from 'axios';

export interface WorkerConfig {
  rabbitMqUrl: string;
  rpcUrl: string;
  maxConcurrentJobs: number;
  retryAttempts: number;
  retryDelay: number;
}

/**
 * Production-ready worker that processes token enrichment jobs
 * Uses RabbitMQ for job queuing and TokenService for blockchain interaction
 */
export class TokenEnrichmentWorker {
  private readonly config: WorkerConfig;
  private readonly dataSource: DataSource;
  private rabbitMQ: RabbitMQService | null = null;
  private isRunning = false;
  private activeJobs = 0;

  constructor(config: WorkerConfig, dataSource: DataSource) {
    this.config = config;
    this.dataSource = dataSource;
  }

  /**
   * Start the worker and begin processing jobs
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('TokenEnrichmentWorker already running');
      return;
    }

    try {
      // Initialize RabbitMQ connection
      this.rabbitMQ = new RabbitMQService(this.config.rabbitMqUrl);
      await this.rabbitMQ.connect();

      // Start consuming token enrichment jobs
      await this.rabbitMQ.consumeTokenEnrichment(
        this.processTokenEnrichment.bind(this)
      );

      this.isRunning = true;
      logger.info('TokenEnrichmentWorker started successfully', {
        maxConcurrentJobs: this.config.maxConcurrentJobs,
        rpcUrl: this.config.rpcUrl
      });

    } catch (error) {
      logger.error('Failed to start TokenEnrichmentWorker', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Stop the worker gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping TokenEnrichmentWorker...');
    
    // Wait for active jobs to complete
    while (this.activeJobs > 0) {
      logger.info(`Waiting for ${this.activeJobs} active jobs to complete...`);
      await this.sleep(1000);
    }

    // Close RabbitMQ connection
    if (this.rabbitMQ) {
      await this.rabbitMQ.close();
      this.rabbitMQ = null;
    }

    this.isRunning = false;
    logger.info('TokenEnrichmentWorker stopped');
  }

  /**
   * Process a token enrichment job
   */
  private async processTokenEnrichment(message: TokenEnrichmentMessage): Promise<void> {
    // Check concurrency limit
    if (this.activeJobs >= this.config.maxConcurrentJobs) {
      throw new Error('Max concurrent jobs limit reached');
    }

    this.activeJobs++;
    
    try {
      logger.info('Processing token enrichment', {
        tokenAddress: message.tokenAddress,
        blockNumber: message.blockNumber,
        transactionHash: message.transactionHash
      });

      // Create RPC client for this specific block
      const rpcClient = this.createRpcClient();
      const tokenService = TokenService.createStandalone(rpcClient, message.blockNumber);

      // Process within database transaction
      await this.dataSource.transaction(async (entityManager: EntityManager) => {
        const store = new Store(() => entityManager);
        await this.enrichToken(store, tokenService, message);
      });

      logger.info('Token enrichment completed successfully', {
        tokenAddress: message.tokenAddress,
        blockNumber: message.blockNumber
      });

    } catch (error) {
      logger.error('Token enrichment failed', {
        tokenAddress: message.tokenAddress,
        blockNumber: message.blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error; // Re-throw to trigger retry mechanism
    } finally {
      this.activeJobs--;
    }
  }

  /**
   * Perform the actual token enrichment
   */
  private async enrichToken(
    store: Store,
    tokenService: TokenService,
    message: TokenEnrichmentMessage
  ): Promise<void> {
    const { tokenAddress } = message;

    // Check if token already exists
    const existingToken = await store.get(Token, tokenAddress);
    if (existingToken) {
      logger.debug('Token already exists, updating if needed', {
        tokenAddress,
        currentBlock: message.blockNumber
      });
    }

    // Fetch token metadata from blockchain
    const metadata = await tokenService.fetchTokenMetadata(tokenAddress);
    if (!metadata) {
      logger.warn('Unable to fetch token metadata', { tokenAddress });
      return;
    }

    // Save/update token in database
    await tokenService.createOrUpdateToken(store, tokenAddress, metadata);

    logger.info('Token enriched successfully', {
      tokenAddress,
      name: metadata.name,
      symbol: metadata.symbol,
      tokenType: metadata.tokenType
    });
  }

  /**
   * Check if token metadata is up to date
   */
  private isTokenUpToDate(token: any, currentBlock: number): boolean {
    // Consider token up to date if it was updated within the last 1000 blocks
    const blockThreshold = 1000;
    return token.lastUpdateBlock && 
           (currentBlock - token.lastUpdateBlock) < blockThreshold;
  }

  /**
   * Create RPC client for blockchain calls
   */
  private createRpcClient() {
    const rpcUrl = this.config.rpcUrl;
    return {
      async call<T = any>(method: string, params?: unknown[]): Promise<T> {
        const response = await axios.post(rpcUrl, {
          jsonrpc: '2.0',
          method,
          params: params || [],
          id: Date.now()
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (response.data.error) {
          throw new Error(`RPC Error: ${response.data.error.message}`);
        }

        return response.data.result;
      }
    };
  }

  /**
   * Add a token enrichment job to the queue
   */
  async enqueueTokenEnrichment(message: TokenEnrichmentMessage): Promise<void> {
    if (!this.rabbitMQ) {
      throw new Error('RabbitMQ not connected');
    }

    await this.rabbitMQ.publishTokenEnrichment(message);
    
    logger.debug('Token enrichment job enqueued', {
      tokenAddress: message.tokenAddress,
      blockNumber: message.blockNumber
    });
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeJobs: this.activeJobs,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      connected: this.rabbitMQ?.connected || false
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
} 