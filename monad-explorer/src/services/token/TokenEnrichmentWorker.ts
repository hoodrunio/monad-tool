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
    const { tokenAddress, blockNumber, detectedType } = message;
    
    try {
      // Check if token already has complete metadata in cache/database
      const existingToken = await this.tokenRepository.get(tokenAddress);
      
      // Skip if already fully enriched with complete metadata
      const hasCompleteMetadata = existingToken && 
        existingToken.name && 
        existingToken.symbol && 
        typeof existingToken.decimals === 'number';

      // Skip if already processed (even if metadata is incomplete)
      const isAlreadyProcessed = existingToken && existingToken.processed === true;

      if (hasCompleteMetadata || isAlreadyProcessed) {
        logger.debug('Token already processed, skipping', {
          tokenAddress,
          hasCompleteMetadata,
          isProcessed: existingToken?.processed
        });
        this.processedCount++; // Count skipped tokens as processed
        return;
      }

      // Use detected type from event analysis (no cascade)
      const tokenType = this.parseTokenType(detectedType) || TokenType.ERC20;

     /*  logger.debug('Fetching metadata for token', {
        tokenAddress,
        tokenType,
        blockNumber,
        message: 'This is where the REAL metadata fetching happens'
      }); */

      // Fetch metadata for the specific detected type only
      const metadata = await this.metadataFetcher.fetchMetadata(tokenAddress, tokenType, blockNumber);

      if (!metadata || !metadata.contractExists) {
        logger.warn('Failed to fetch token metadata or contract does not exist', { 
          tokenAddress, 
          blockNumber,
          tokenType,
        });
        this.processedCount++; // Count failed fetches as processed
        return;
      }

      logger.debug('Token metadata fetched successfully', {
        tokenAddress,
        tokenType,
        metadata: {
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          // Convert BigInt to string for logging
          totalSupply: metadata.totalSupply ? metadata.totalSupply.toString() : undefined,
          contractExists: metadata.contractExists,
        },
      });

      // Save to both Redis and PostgreSQL
      await this.saveEnrichedToken(tokenAddress, tokenType, metadata);
      
      // Count successful processing
      this.processedCount++;

    } catch (error) {
      this.errorCount++; // Count errors
      logger.error('Error processing token enrichment', {
        tokenAddress,
        blockNumber,
        detectedType,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
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
      processed: metadata.processed || false,
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
   * Update PostgreSQL Token entity with enriched metadata using atomic transaction
   * SINGLE WRITER PRINCIPLE: Only this worker updates token metadata
   */
  private async updatePostgreSQLToken(address: string, metadata: TokenMetadata): Promise<void> {
    if (!this.dataSource || !this.dataSource.isInitialized) {
      logger.warn('PostgreSQL DataSource not initialized, skipping update', { address });
      return;
    }

    // Use transaction for atomic status + metadata update
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const tokenRepository = queryRunner.manager.getRepository(Token);
      
      logger.debug('Attempting atomic PostgreSQL token update', {
        address,
        metadata: {
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          totalSupply: metadata.totalSupply ? metadata.totalSupply.toString() : undefined,
          contractExists: metadata.contractExists,
        },
      });

      // 🔒 ATOMIC: Find and lock token with PENDING status for update
      const tokenToUpdate = await queryRunner.query(`
        SELECT * FROM token 
        WHERE (address = $1 OR address = $2) 
        AND enrichment_status = 'PENDING'
        FOR UPDATE NOWAIT
      `, [address.toLowerCase(), address]);

      if (!tokenToUpdate || tokenToUpdate.length === 0) {
        logger.debug('Token not found or not in PENDING status, skipping update', { 
          address,
          searchedAddresses: [address.toLowerCase(), address],
        });
        await queryRunner.rollbackTransaction();
        return;
      }

      const token = tokenToUpdate[0];

      // 🔒 ATOMIC: Update metadata AND status in single operation
      const updateData: any = {
        enrichment_status: metadata.contractExists ? 'ENRICHED' : 'FAILED',
        enriched_at: new Date(),
        enrichment_attempts: (token.enrichment_attempts || 0) + 1,
      };

      // Only update fields that have valid data
      if (metadata.name) {
        updateData.name = metadata.name;
      }
      if (metadata.symbol) {
        updateData.symbol = metadata.symbol;
      }
      if (metadata.decimals !== undefined) {
        updateData.decimals = metadata.decimals;
      }
      if (metadata.totalSupply) {
        updateData.total_supply = metadata.totalSupply.toString();
      }

      // Build SET clause dynamically
      const setClause = Object.keys(updateData)
        .map((key, index) => `${key} = $${index + 2}`)
        .join(', ');
      
      const values = [token.address, ...Object.values(updateData)];

      await queryRunner.query(`
        UPDATE token 
        SET ${setClause}
        WHERE address = $1
      `, values);

      await queryRunner.commitTransaction();

      logger.debug('✅ PostgreSQL token updated atomically', {
        address: token.address,
        status: updateData.enrichment_status,
        updatedFields: Object.keys(updateData),
        attempts: updateData.enrichment_attempts,
      });

    } catch (error) {
      await queryRunner.rollbackTransaction();
      
      if (error instanceof Error && error.message.includes('could not obtain lock')) {
        logger.debug('Token is being processed by another worker, skipping', { address });
        return;
      }

      logger.error('❌ Failed to update PostgreSQL token atomically', {
        address,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await queryRunner.release();
    }
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