import { IQueueService, ContractEnrichmentMessage } from '../../interfaces/services/IQueueService';
import { IContractMetadataFetcher, ContractMetadata } from '../../interfaces/services/IContractMetadataFetcher';
import { Contract } from '../../model';
import { logger } from '../../utils/logger';
import { DataSource } from 'typeorm';

export interface ContractEnrichmentWorkerConfig {
  concurrency: number;
  retryAttempts: number;
  retryDelay: number;
  batchSize: number;
  processingTimeout: number;
}

/**
 * Background worker for processing contract enrichment messages
 * Consumes from RabbitMQ queue and enriches contracts with metadata, bytecode, and analysis
 * Updates PostgreSQL database with comprehensive contract information
 */
export class ContractEnrichmentWorker {
  private isRunning = false;
  private processedCount = 0;
  private errorCount = 0;
  private startTime?: Date;

  private readonly config: ContractEnrichmentWorkerConfig = {
    concurrency: 2, // Lower concurrency for intensive operations
    retryAttempts: 3,
    retryDelay: 2000, // 2 seconds
    batchSize: 5, // Smaller batch for contract analysis
    processingTimeout: 60000, // 60 seconds for contract analysis
  };

  constructor(
    private readonly queueService: IQueueService,
    private readonly contractMetadataFetcher: IContractMetadataFetcher,
    private readonly dataSource: DataSource,
    config?: Partial<ContractEnrichmentWorkerConfig>
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
      logger.warn('Contract enrichment worker is already running');
      return;
    }

    if (!this.queueService.isConnected()) {
      throw new Error('Queue service is not connected');
    }

    this.isRunning = true;
    this.startTime = new Date();
    this.processedCount = 0;
    this.errorCount = 0;

    logger.info('Starting contract enrichment worker', {
      concurrency: this.config.concurrency,
      batchSize: this.config.batchSize,
      timeout: this.config.processingTimeout,
    });

    try {
      await this.queueService.consumeContractEnrichment(
        this.processContractEnrichment.bind(this),
        {
          concurrency: this.config.concurrency,
          prefetch: this.config.batchSize,
          autoAck: false,
        }
      );

      logger.info('Contract enrichment worker started successfully');
    } catch (error) {
      this.isRunning = false;
      logger.error('Failed to start contract enrichment worker', {
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
      logger.warn('Contract enrichment worker is not running');
      return;
    }

    this.isRunning = false;
    logger.info('Stopping contract enrichment worker...');

    const duration = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    logger.info('Contract enrichment worker stopped', {
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
   * Process a single contract enrichment message
   */
  private async processContractEnrichment(message: ContractEnrichmentMessage): Promise<void> {
    const { contractAddress, creator, blockNumber } = message;
    
    try {
      // Check if contract is already enriched
      const existingContract = await this.getContractFromDatabase(contractAddress);
      
      if (existingContract && existingContract.isVerified) {
        logger.debug('Contract already enriched, skipping', {
          contractAddress,
          isVerified: existingContract.isVerified,
        });
        this.processedCount++;
        return;
      }

      logger.debug('Fetching contract metadata', {
        contractAddress,
        creator,
        blockNumber,
      });

      // Fetch comprehensive contract metadata
      // Skip contractExists check since ContractDiscoveryService already confirmed it's a contract
      const metadata = await this.contractMetadataFetcher.fetchMetadata(contractAddress, {
        blockNumber,
        fetchBytecode: false, // ✅ OPTIMIZATION: Skip bytecode fetch during enrichment - fetch on-demand only
        detectTokenInterface: true,
        analyzeProxy: true,
        timeout: this.config.processingTimeout - 10000, // Leave 10s buffer
        skipContractCheck: true, // ✅ OPTIMIZATION: Skip getCode call - already confirmed during contract discovery
      });

      if (!metadata.contractExists) {
        logger.warn('Contract does not exist, skipping enrichment', { 
          contractAddress, 
          blockNumber 
        });
        this.processedCount++;
        return;
      }

      logger.debug('Contract metadata fetched successfully', {
        contractAddress,
        contractExists: metadata.contractExists,
        isToken: metadata.isToken,
        tokenType: metadata.tokenType,
        isProxied: metadata.isProxied,
        contractType: metadata.contractType,
        bytecodeSize: metadata.runtimeBytecode ? metadata.runtimeBytecode.length : 0,
      });

      // Update contract in database
      await this.updateContractInDatabase(contractAddress, metadata, creator);
      
      this.processedCount++;

    } catch (error) {
      this.errorCount++;
      logger.error('Error processing contract enrichment', {
        contractAddress,
        creator,
        blockNumber,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Get contract from database
   */
  private async getContractFromDatabase(address: string): Promise<Contract | null> {
    if (!this.dataSource || !this.dataSource.isInitialized) {
      return null;
    }

    try {
      const contractRepository = this.dataSource.getRepository(Contract);
      return await contractRepository.findOne({
        where: { address: address.toLowerCase() }
      });
    } catch (error) {
      logger.debug('Failed to get contract from database', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Update contract in PostgreSQL database with enriched metadata
   */
  private async updateContractInDatabase(
    address: string,
    metadata: ContractMetadata,
    creator: string
  ): Promise<void> {
    if (!this.dataSource || !this.dataSource.isInitialized) {
      logger.warn('PostgreSQL DataSource not initialized, skipping contract update', { address });
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      logger.debug('Updating contract in database', {
        address,
        metadata: {
          contractExists: metadata.contractExists,
          isToken: metadata.isToken,
          tokenType: metadata.tokenType,
          isProxied: metadata.isProxied,
          contractType: metadata.contractType,
          isVerified: metadata.isVerified,
        },
      });

      // Check if contract exists in database
      const existingContract = await queryRunner.query(`
        SELECT * FROM contract 
        WHERE address = $1
        FOR UPDATE NOWAIT
      `, [address.toLowerCase()]);

      const updateData: any = {
        bytecode: metadata.runtimeBytecode || null,
        is_verified: metadata.isVerified || false,
        name: metadata.sourceName || null,
        compiler_version: metadata.compilerVersion || null,
      };

      if (existingContract && existingContract.length > 0) {
        // Update existing contract
        const setClause = Object.keys(updateData)
          .map((key, index) => `${key} = $${index + 2}`)
          .join(', ');
        
        const values = [address.toLowerCase(), ...Object.values(updateData)];

        await queryRunner.query(`
          UPDATE contract 
          SET ${setClause}
          WHERE address = $1
        `, values);

        logger.debug('✅ Contract updated in database', {
          address,
          updatedFields: Object.keys(updateData),
        });
      } else {
        // Insert new contract (shouldn't happen usually as BlockProcessor creates it first)
        await queryRunner.query(`
          INSERT INTO contract (
            id, address, creator, created_at, bytecode, is_verified, name, compiler_version
          ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)
        `, [
          address.toLowerCase(),
          address.toLowerCase(),
          creator.toLowerCase(),
          updateData.bytecode,
          updateData.is_verified,
          updateData.name,
          updateData.compiler_version,
        ]);

        logger.debug('✅ Contract inserted into database', {
          address,
          creator,
        });
      }

      await queryRunner.commitTransaction();

    } catch (error) {
      await queryRunner.rollbackTransaction();
      
      if (error instanceof Error && error.message.includes('could not obtain lock')) {
        logger.debug('Contract is being processed by another worker, skipping', { address });
        return;
      }

      logger.error('❌ Failed to update contract in database', {
        address,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
} 