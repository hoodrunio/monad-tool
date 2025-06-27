import { IQueueService, TokenEnrichmentMessage } from '../../interfaces/services/IQueueService';
import { ITokenMetadataFetcher, TokenMetadata } from '../../interfaces/services/ITokenMetadataFetcher';
import { ITokenRepository, TokenInfo } from '../../interfaces/services/ITokenRepository';
import { TokenType } from '../../model';
import { logger } from '../../utils/logger';

export interface TokenEnrichmentWorkerConfig {
  concurrency: number;
  retryAttempts: number;
  retryDelay: number;
  batchSize: number;
  processingTimeout: number;
}

/**
 * Background worker for processing token enrichment messages
 * Consumes from RabbitMQ queue and enriches tokens with metadata
 */
export class TokenEnrichmentWorker {
  private isRunning = false;
  private processedCount = 0;
  private errorCount = 0;
  private startTime?: Date;

  private readonly config: TokenEnrichmentWorkerConfig = {
    concurrency: 3,
    retryAttempts: 3,
    retryDelay: 1000,
    batchSize: 10,
    processingTimeout: 30000, // 30 seconds
  };

  constructor(
    private readonly queueService: IQueueService,
    private readonly metadataFetcher: ITokenMetadataFetcher,
    private readonly tokenRepository: ITokenRepository,
    config?: Partial<TokenEnrichmentWorkerConfig>
  ) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Start the worker
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Token enrichment worker is already running');
      return;
    }

    if (!this.queueService.isConnected()) {
      throw new Error('Queue service is not connected');
    }

    this.isRunning = true;
    this.startTime = new Date();
    this.processedCount = 0;
    this.errorCount = 0;

    logger.info('Starting token enrichment worker', {
      concurrency: this.config.concurrency,
      batchSize: this.config.batchSize,
    });

    try {
      await this.queueService.consumeTokenEnrichment(
        this.processEnrichmentMessage.bind(this),
        {
          concurrency: this.config.concurrency,
          prefetch: this.config.batchSize,
          autoAck: false,
        }
      );

      logger.info('Token enrichment worker started successfully');
    } catch (error) {
      this.isRunning = false;
      logger.error('Failed to start token enrichment worker', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Stop the worker
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Token enrichment worker is not running');
      return;
    }

    this.isRunning = false;
    logger.info('Stopping token enrichment worker...');

    // TODO: Implement graceful shutdown if queue service supports it
    // For now, just mark as stopped

    const duration = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    logger.info('Token enrichment worker stopped', {
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      duration: `${Math.round(duration / 1000)}s`,
    });
  }

  /**
   * Get worker statistics
   */
  public getStats(): {
    isRunning: boolean;
    processedCount: number;
    errorCount: number;
    uptime: number;
    processingRate: number;
  } {
    const uptime = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const processingRate = uptime > 0 ? (this.processedCount / (uptime / 1000)) : 0;

    return {
      isRunning: this.isRunning,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      uptime,
      processingRate,
    };
  }

  /**
   * Process a single token enrichment message
   */
  private async processEnrichmentMessage(message: TokenEnrichmentMessage): Promise<void> {
    const startTime = Date.now();
    
    logger.debug('Processing token enrichment message', {
      tokenAddress: message.tokenAddress,
      blockNumber: message.blockNumber,
    });

    try {
      // Check if token already exists with metadata
      const existingToken = await this.tokenRepository.get(message.tokenAddress);
      if (existingToken && this.hasMetadata(existingToken)) {
        logger.debug('Token already enriched, skipping', {
          tokenAddress: message.tokenAddress,
        });
        this.processedCount++;
        return;
      }

      // Determine token type from message or detect it
      const tokenType = this.parseTokenType(message.detectedType);
      if (!tokenType) {
        logger.warn('Invalid token type in message', {
          tokenAddress: message.tokenAddress,
          detectedType: message.detectedType,
        });
        this.errorCount++;
        return;
      }

      // Fetch metadata from blockchain
      const metadata = await this.fetchMetadataWithTimeout(
        message.tokenAddress,
        tokenType,
        message.blockNumber
      );

      if (!metadata.contractExists) {
        logger.debug('Contract does not exist, skipping enrichment', {
          tokenAddress: message.tokenAddress,
          blockNumber: message.blockNumber,
        });
        this.processedCount++;
        return;
      }

      // Save enriched token to repository
      await this.saveEnrichedToken(message.tokenAddress, tokenType, metadata);

      const duration = Date.now() - startTime;
      this.processedCount++;

      logger.debug('Token enrichment completed', {
        tokenAddress: message.tokenAddress,
        tokenType,
        name: metadata.name,
        symbol: metadata.symbol,
        duration: `${duration}ms`,
      });

    } catch (error) {
      this.errorCount++;
      const duration = Date.now() - startTime;
      
      logger.error('Token enrichment failed', {
        tokenAddress: message.tokenAddress,
        blockNumber: message.blockNumber,
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Re-throw to trigger retry mechanism in queue
      throw error;
    }
  }

  /**
   * Fetch metadata with timeout protection
   */
  private async fetchMetadataWithTimeout(
    tokenAddress: string,
    tokenType: TokenType,
    blockNumber?: number
  ): Promise<TokenMetadata> {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Metadata fetch timeout after ${this.config.processingTimeout}ms`));
      }, this.config.processingTimeout);

      try {
        const metadata = await this.metadataFetcher.fetchMetadata(
          tokenAddress,
          tokenType,
          blockNumber
        );
        clearTimeout(timeout);
        resolve(metadata);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Save enriched token to repository
   */
  private async saveEnrichedToken(
    address: string,
    tokenType: TokenType,
    metadata: TokenMetadata
  ): Promise<void> {
    const tokenInfo: TokenInfo = {
      address,
      type: tokenType,
      name: metadata.name || undefined,
      symbol: metadata.symbol || undefined,
      decimals: metadata.decimals ?? undefined,
      totalSupply: metadata.totalSupply || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.tokenRepository.save(tokenInfo);

    logger.debug('Enriched token saved to repository', {
      address,
      type: tokenType,
      name: metadata.name,
      symbol: metadata.symbol,
    });
  }

  /**
   * Check if token already has metadata
   */
  private hasMetadata(token: TokenInfo): boolean {
    return Boolean(token.name || token.symbol || token.decimals !== null);
  }

  /**
   * Parse token type from string
   */
  private parseTokenType(detectedType?: string): TokenType | null {
    if (!detectedType) return null;

    switch (detectedType.toUpperCase()) {
      case 'ERC20':
        return TokenType.ERC20;
      case 'ERC721':
        return TokenType.ERC721;
      case 'ERC1155':
        return TokenType.ERC1155;
      default:
        return null;
    }
  }
} 