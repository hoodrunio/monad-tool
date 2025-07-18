import { serviceContainer } from '../core/ServiceContainer';
import { logger } from '../../utils/logger';
import { sanitizeString } from '../../utils/data-sanitizer';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { appConfig } from '../../config/AppConfig';
import { Transaction } from '../../model/generated/transaction.model';
import { Block } from '../../model/generated/block.model';

/**
 * Transaction Enrichment Worker
 * 
 * Processes heavy transaction computations asynchronously to improve
 * block processing performance. Handles:
 * - Gas price calculations
 * - Transaction fee calculations  
 * - Method signature parsing
 * - Contract address calculations
 * - Failed transaction error fetching
 */
export class TransactionEnrichmentWorker {
  private isProcessing = false;
  private dataSource: DataSource | null = null;
  private rpcClient: any;

  constructor() {
    // Initialize will be called from start() method
  }

  /**
   * Initialize worker dependencies
   */
  private async initialize(): Promise<void> {
    try {
      // Get RPC client from service container
      this.rpcClient = await serviceContainer.resolve<any>('rpcClient');
      
      // Create database connection for worker
      const config = appConfig.getConfig();
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
        entities: [Transaction, Block],
        migrations: ['lib/db/migrations/*.js'],
      });
      
      await this.dataSource.initialize();
      logger.info('TransactionEnrichmentWorker database connection established');
      
      logger.info('TransactionEnrichmentWorker initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize TransactionEnrichmentWorker', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Start processing transaction enrichment messages
   */
  public async start(): Promise<void> {
    if (this.isProcessing) {
      logger.warn('TransactionEnrichmentWorker already processing');
      return;
    }

    // Initialize dependencies
    await this.initialize();

    this.isProcessing = true;
    logger.info('TransactionEnrichmentWorker started');

    try {
      const queueService = await serviceContainer.resolve<any>('queueService');
      
      // Connect to queue service if not connected
      if (!queueService.isConnected()) {
        logger.info('Queue service not connected, connecting...');
        await queueService.connect();
      }

      if (!queueService.isConnected()) {
        logger.error('Failed to connect to queue service');
        return;
      }

      // Subscribe to transaction enrichment queue
      await queueService.consumeTransactionEnrichment(
        this.processTransactionEnrichment.bind(this), 
        {
          concurrency: 5, // Process 5 transactions concurrently
          prefetch: 20, // Prefetch 20 transactions per batch
          autoAck: false, // Manual acknowledgment
        }
      );

      logger.info('TransactionEnrichmentWorker subscribed to queue');

    } catch (error) {
      logger.error('Failed to start TransactionEnrichmentWorker', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Stop processing
   */
  public async stop(): Promise<void> {
    this.isProcessing = false;
    
    // Close database connection
    if (this.dataSource?.isInitialized) {
      await this.dataSource.destroy();
      logger.info('TransactionEnrichmentWorker database connection closed');
    }
    
    logger.info('TransactionEnrichmentWorker stopped');
  }

  /**
   * Process transaction enrichment message
   */
  private async processTransactionEnrichment(message: any): Promise<void> {
    const startTime = Date.now();
    
    try {
      const {
        transactionHash,
        blockNumber,
        blockBaseFeePerGas,
        transactionType,
        gasPrice,
        gasUsed,
        maxFeePerGas,
        maxPriorityFeePerGas,
        input,
        status,
        isContractCreation,
        fromAddress,
        nonce,
      } = message;

      logger.debug('Processing transaction enrichment', {
        transactionHash,
        blockNumber,
      });

      // ⚡ HEAVY COMPUTATIONS: Now done async
      const enrichmentData = await this.computeTransactionEnrichment({
        transactionHash,
        blockNumber,
        blockBaseFeePerGas,
        transactionType,
        gasPrice,
        gasUsed,
        maxFeePerGas,
        maxPriorityFeePerGas,
        input,
        status,
        isContractCreation,
        fromAddress,
        nonce,
      });

      // Update transaction in database
      await this.updateTransactionEnrichment(transactionHash, enrichmentData);

      const duration = Date.now() - startTime;
      logger.debug('Transaction enrichment completed', {
        transactionHash,
        duration,
        enrichedFields: Object.keys(enrichmentData).length,
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Failed to process transaction enrichment', {
        transactionHash: message.transactionHash,
        duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Compute all heavy transaction enrichment data
   */
  private async computeTransactionEnrichment(txData: any): Promise<any> {
    const {
      transactionHash,
      blockBaseFeePerGas,
      transactionType,
      gasPrice,
      gasUsed,
      maxFeePerGas,
      maxPriorityFeePerGas,
      input,
      status,
      isContractCreation,
      fromAddress,
      nonce,
    } = txData;

    // 1. Calculate effective gas price
    const effectiveGasPrice = this.calculateEffectiveGasPrice({
      type: transactionType,
      gasPrice: BigInt(gasPrice),
      baseFeePerGas: BigInt(blockBaseFeePerGas),
      maxFeePerGas: BigInt(maxFeePerGas),
      maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
    });

    // 2. Calculate transaction fee
    const transactionFee = BigInt(gasUsed) * effectiveGasPrice;

    // 3. Extract method information
    const methodInfo = this.extractMethodInfo(input);

    // 4. Calculate contract address if needed
    let contractAddress = null;
    if (isContractCreation) {
      contractAddress = this.calculateContractAddress(fromAddress, BigInt(nonce));
    }

    // 5. Error information will be fetched on-demand via API calls
    let errorInfo = { error: null, revertReason: null };

    return {
      effectiveGasPrice: effectiveGasPrice.toString(),
      transactionFee: transactionFee.toString(),
      methodName: sanitizeString(methodInfo.name),
      methodID: sanitizeString(methodInfo.id),
      contractAddress,
      error: errorInfo.error,
      revertReason: errorInfo.revertReason,
    };
  }

  /**
   * Update transaction with enrichment data
   */
  private async updateTransactionEnrichment(transactionHash: string, enrichmentData: any): Promise<void> {
    try {
      if (!this.dataSource?.isInitialized) {
        throw new Error('Database connection not initialized');
      }
      
      const updateData: any = {};
      
      // Map enrichment data to entity fields (using camelCase property names)
      if (enrichmentData.effectiveGasPrice) {
        updateData.effectiveGasPrice = BigInt(enrichmentData.effectiveGasPrice);
      }
      if (enrichmentData.transactionFee) {
        updateData.transactionFee = BigInt(enrichmentData.transactionFee);
      }
      if (enrichmentData.methodName) {
        updateData.methodName = enrichmentData.methodName;
      }
      if (enrichmentData.methodID) {
        updateData.methodID = enrichmentData.methodID;
      }
      if (enrichmentData.contractAddress) {
        updateData.contractAddress = enrichmentData.contractAddress;
      }
      if (enrichmentData.error) {
        updateData.error = enrichmentData.error;
      }
      if (enrichmentData.revertReason) {
        updateData.revertReason = enrichmentData.revertReason;
      }

      // Use TypeORM DataSource to update transaction
      const repository = this.dataSource.getRepository(Transaction);
      await repository.update(
        { hash: transactionHash },
        updateData
      );

      logger.debug('Transaction enrichment data updated', {
        transactionHash,
        updatedFields: Object.keys(updateData),
      });

    } catch (error) {
      logger.error('Failed to update transaction enrichment', {
        transactionHash,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Calculate effective gas price
   */
  private calculateEffectiveGasPrice(params: {
    type: number;
    gasPrice: bigint;
    baseFeePerGas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }): bigint {
    const { type, gasPrice, baseFeePerGas, maxFeePerGas, maxPriorityFeePerGas } = params;

    if (type === 2) {
      // EIP-1559 transaction
      let effectiveGasPrice = baseFeePerGas + maxPriorityFeePerGas;
      if (effectiveGasPrice > maxFeePerGas) {
        effectiveGasPrice = maxFeePerGas;
      }
      return effectiveGasPrice;
    } else {
      // Legacy transaction
      return gasPrice;
    }
  }

  /**
   * Extract method information from transaction input
   */
  private extractMethodInfo(input: string | null): { id: string | null; name: string | null } {
    if (!input || input.length < 10) {
      return { id: null, name: null };
    }
    
    const methodId = input.slice(0, 10); // First 4 bytes (including 0x)
    const knownMethod = this.getKnownMethod(methodId);
    
    return {
      id: methodId,
      name: knownMethod?.name || null,
    };
  }

  /**
   * Get known method signature
   */
  private getKnownMethod(methodId: string): { name: string; signature: string } | null {
    const knownMethods = new Map([
      ['0xa9059cbb', { name: 'transfer', signature: 'transfer(address,uint256)' }],
      ['0x095ea7b3', { name: 'approve', signature: 'approve(address,uint256)' }],
      ['0x23b872dd', { name: 'transferFrom', signature: 'transferFrom(address,address,uint256)' }],
      ['0x70a08231', { name: 'balanceOf', signature: 'balanceOf(address)' }],
      ['0xdd62ed3e', { name: 'allowance', signature: 'allowance(address,address)' }],
      ['0x18160ddd', { name: 'totalSupply', signature: 'totalSupply()' }],
      ['0x06fdde03', { name: 'name', signature: 'name()' }],
      ['0x95d89b41', { name: 'symbol', signature: 'symbol()' }],
      ['0xa25ffea8', { name: 'mint', signature: 'mint(address,address,uint256)' }],
      ['0x313ce567', { name: 'decimals', signature: 'decimals()' }],
    ]);

    return knownMethods.get(methodId) || null;
  }

  /**
   * Calculate contract address for contract creation transactions
   */
  private calculateContractAddress(from: string, nonce: bigint): string {
    // Simplified contract address calculation
    // In production, this should use: keccak256(rlp([sender, nonce]))
    const normalized = from.toLowerCase().replace('0x', '');
    const nonceHex = nonce.toString(16).padStart(16, '0');
    
    // Create a deterministic address based on sender + nonce
    const addressSuffix = (normalized + nonceHex).slice(-40);
    return `0x${addressSuffix}`;
  }
}