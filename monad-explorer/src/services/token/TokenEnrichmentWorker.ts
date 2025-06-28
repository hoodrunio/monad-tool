import { IQueueService, TokenEnrichmentMessage } from '../../interfaces/services/IQueueService';
import { ITokenMetadataFetcher, TokenMetadata } from '../../interfaces/services/ITokenMetadataFetcher';
import { ITokenRepository, TokenInfo } from '../../interfaces/services/ITokenRepository';
import { TokenType, Token } from '../../model';
import { logger } from '../../utils/logger';
import { DataSource } from 'typeorm';

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
 * Updates both Redis cache and PostgreSQL database
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
    private readonly dataSource: DataSource, // Add TypeORM connection
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
        this.processTokenEnrichment.bind(this),
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
  private async processTokenEnrichment(message: TokenEnrichmentMessage): Promise<void> {
    const { tokenAddress, blockNumber } = message;
    
    logger.debug('Processing token enrichment message', {
      tokenAddress,
      blockNumber,
    });

    try {
      // Check if token already has complete metadata in Redis
      const existingToken = await this.tokenRepository.get(tokenAddress);
      const hasCompleteMetadata = existingToken && 
        existingToken.name && 
        existingToken.symbol && 
        typeof existingToken.decimals === 'number';

      if (hasCompleteMetadata) {
        logger.debug('Token has complete metadata in Redis, updating PostgreSQL', {
          tokenAddress,
          existingMetadata: {
            name: existingToken.name,
            symbol: existingToken.symbol,
            decimals: existingToken.decimals,
            // Convert BigInt to string for logging
            totalSupply: existingToken.totalSupply ? existingToken.totalSupply.toString() : undefined,
          },
        });

        // Even if Redis has metadata, we need to update PostgreSQL
        const metadata: TokenMetadata = {
          name: existingToken.name,
          symbol: existingToken.symbol,
          decimals: existingToken.decimals,
          totalSupply: existingToken.totalSupply,
          contractExists: true, // If we have metadata, contract exists
        };

        await this.updatePostgreSQLToken(tokenAddress, metadata);
        return;
      }

      // Fetch fresh metadata if not available or incomplete
      logger.debug('Token needs metadata fetching', {
        tokenAddress,
        hasExisting: !!existingToken,
        existingMetadata: existingToken ? {
          name: existingToken.name,
          symbol: existingToken.symbol,
          decimals: existingToken.decimals,
          // Convert BigInt to string for logging
          totalSupply: existingToken.totalSupply ? existingToken.totalSupply.toString() : undefined,
        } : null,
      });

      // Try ERC20 first, then ERC721 if it fails
      let metadata = await this.metadataFetcher.fetchMetadata(tokenAddress, TokenType.ERC20, blockNumber);
      
      if (!metadata || !metadata.contractExists) {
        // Try ERC721 if ERC20 failed
        metadata = await this.metadataFetcher.fetchMetadata(tokenAddress, TokenType.ERC721, blockNumber);
      }

      if (!metadata || !metadata.contractExists) {
        logger.warn('Failed to fetch token metadata or contract does not exist', { 
          tokenAddress, 
          blockNumber 
        });
        return;
      }

      logger.debug('Token metadata fetched successfully', {
        tokenAddress,
        metadata: {
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          // Convert BigInt to string for logging
          totalSupply: metadata.totalSupply ? metadata.totalSupply.toString() : undefined,
          contractExists: metadata.contractExists,
        },
      });

      // Determine token type based on metadata
      const tokenType = metadata.decimals !== undefined ? TokenType.ERC20 : TokenType.ERC721;

      // Save to both Redis and PostgreSQL
      await this.saveEnrichedToken(tokenAddress, tokenType, metadata);

    } catch (error) {
      logger.error('Error processing token enrichment', {
        tokenAddress,
        blockNumber,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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
   * Save enriched token to both Redis cache and PostgreSQL database
   */
  private async saveEnrichedToken(
    address: string,
    tokenType: TokenType,
    metadata: TokenMetadata
  ): Promise<void> {
    // Prepare token info for Redis cache
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

    try {
      // 1. Save to Redis cache for fast access
      await this.tokenRepository.save(tokenInfo);

      // 2. Update PostgreSQL database for GraphQL queries  
      await this.updatePostgreSQLToken(address, metadata);

      logger.debug('✅ Token enrichment completed successfully', {
        address,
        type: tokenType,
        metadata: {
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          // Convert BigInt to string for logging
          totalSupply: metadata.totalSupply ? metadata.totalSupply.toString() : undefined,
        },
      });

    } catch (error) {
      logger.error('Failed to save enriched token', {
        address,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update PostgreSQL Token entity with enriched metadata
   */
  private async updatePostgreSQLToken(address: string, metadata: TokenMetadata): Promise<void> {
    if (!this.dataSource || !this.dataSource.isInitialized) {
      logger.warn('PostgreSQL DataSource not initialized, skipping update', { address });
      return;
    }

    try {
      const tokenRepository = this.dataSource.getRepository(Token);
      
      logger.debug('Attempting PostgreSQL token update', {
        address,
        metadata: {
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          // Convert BigInt to string for logging
          totalSupply: metadata.totalSupply ? metadata.totalSupply.toString() : undefined,
          contractExists: metadata.contractExists,
        },
      });

      // Find existing token by address (try both cases)
      const existingToken = await tokenRepository.findOne({
        where: { address: address.toLowerCase() }
      });

      if (!existingToken) {
        // Try original case if lowercase didn't work
        const existingTokenOriginal = await tokenRepository.findOne({
          where: { address: address }
        });

        if (!existingTokenOriginal) {
          logger.warn('Token not found in PostgreSQL database, skipping update', { 
            address,
            triedAddresses: [address.toLowerCase(), address],
          });
          return;
        }
      }

      const tokenToUpdate = existingToken || await tokenRepository.findOne({
        where: { address: address }
      });

      if (!tokenToUpdate) {
        logger.warn('Unable to find token in PostgreSQL for update', { address });
        return;
      }

      // Update with enriched metadata
      const updateData: Partial<Token> = {};
      
      if (metadata.name && metadata.name !== tokenToUpdate.name) {
        updateData.name = metadata.name;
      }
      
      if (metadata.symbol && metadata.symbol !== tokenToUpdate.symbol) {
        updateData.symbol = metadata.symbol;
      }
      
      if (metadata.decimals !== undefined && metadata.decimals !== tokenToUpdate.decimals) {
        updateData.decimals = metadata.decimals;
      }

      if (metadata.totalSupply && metadata.totalSupply !== tokenToUpdate.totalSupply) {
        updateData.totalSupply = metadata.totalSupply;
      }

      // Only update if we have changes
      if (Object.keys(updateData).length === 0) {
        logger.debug('No changes needed for PostgreSQL token', { address });
        return;
      }

      // Perform the update
      await tokenRepository.update(
        { address: tokenToUpdate.address },
        updateData
      );

      logger.debug('✅ PostgreSQL token updated successfully', {
        address: tokenToUpdate.address,
        updatedFields: Object.keys(updateData),
        changes: {
          name: updateData.name,
          symbol: updateData.symbol,
          decimals: updateData.decimals,
          totalSupply: updateData.totalSupply ? updateData.totalSupply.toString() : undefined,
        },
      });

    } catch (error) {
      logger.error('❌ Failed to update PostgreSQL token', {
        address,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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