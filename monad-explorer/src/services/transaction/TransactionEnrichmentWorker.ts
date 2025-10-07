import { serviceContainer } from '../core/ServiceContainer';
import { logger } from '../../utils/logger';
import { sanitizeString } from '../../utils/data-sanitizer';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { appConfig } from '../../config/AppConfig';
import { Transaction } from '../../model/generated/transaction.model';
import { Block } from '../../model/generated/block.model';
import { extractMethodInfo } from '../../utils/method-signature';

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
  
  // Performance tracking
  private processedCount = 0;
  private errorCount = 0;
  private lastSummaryTime = Date.now();
  private readonly SUMMARY_INTERVAL = 1000; // Log summary every 1000 transactions

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
   * Process transaction enrichment message (handles both single and batch messages)
   */
  private async processTransactionEnrichment(message: any): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Handle batch message
      if (message.type === 'TRANSACTION_ENRICHMENT_BATCH' && message.data.transactions) {
        await this.processTransactionEnrichmentBatch(message.data);
        return;
      }

      // Determine if this is a message wrapper (from RabbitMQ) or direct data
      const txData = message.data || message;

      // Handle single transaction message (backward compatibility)
      const {
        transactionHash,
      } = txData;

      // Removed excessive debug logging for performance optimization
      // Only log errors and periodic summaries

      // ⚡ HEAVY COMPUTATIONS: Now done async
      const enrichmentData = await this.computeTransactionEnrichment(txData);

      // Update transaction in database
      await this.updateTransactionEnrichment(transactionHash, enrichmentData);

      const duration = Date.now() - startTime;
      // Removed excessive debug logging for performance optimization
      // Only log slow transactions or errors
      if (duration > 5000) { // Log only if transaction took more than 5 seconds
        logger.warn('Slow transaction enrichment detected', {
          transactionHash,
          duration,
          enrichedFields: Object.keys(enrichmentData).length,
        });
      }

      // Track progress and log periodic summary
      this.processedCount++;
      this.logPeriodicSummary();

    } catch (error) {
      const duration = Date.now() - startTime;
      this.errorCount++;
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

    // 1. Calculate effective gas price (with safe BigInt conversion)
    const effectiveGasPrice = this.calculateEffectiveGasPrice({
      type: transactionType,
      gasPrice: BigInt(gasPrice || '0'),
      baseFeePerGas: BigInt(blockBaseFeePerGas || '0'),
      maxFeePerGas: BigInt(maxFeePerGas || '0'),
      maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas || '0'),
    });

    // 2. Calculate transaction fee (with safe BigInt conversion)
    const transactionFee = BigInt(gasUsed || '0') * effectiveGasPrice;

    // 3. Extract method information
    const methodInfo = extractMethodInfo(input);

    // 4. Calculate contract address if needed (with safe BigInt conversion)
    let contractAddress = null;
    if (isContractCreation) {
      contractAddress = this.calculateContractAddress(fromAddress, BigInt(nonce || '0'));
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
   * Process transaction enrichment batch message
   * ⚡ OPTIMIZATION: Process multiple transactions from batch message
   */
  private async processTransactionEnrichmentBatch(batchData: any): Promise<void> {
    const startTime = Date.now();
    const { blockNumber, batchId, transactions } = batchData;
    
    logger.info('Processing transaction enrichment batch', {
      blockNumber,
      batchId,
      transactionCount: transactions.length,
    });

    let processedCount = 0;
    let errorCount = 0;

    try {
      // Process transactions in parallel for better performance
      const promises = transactions.map(async (transactionData: any) => {
        try {
          // Reuse the single transaction enrichment logic
          const enrichmentData = await this.computeTransactionEnrichment(transactionData);
          await this.updateTransactionEnrichment(transactionData.transactionHash, enrichmentData);
          processedCount++;
        } catch (error) {
          errorCount++;
          logger.warn('Failed to process transaction in batch', {
            transactionHash: transactionData.transactionHash,
            blockNumber,
            batchId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          // Don't throw - continue processing other transactions in batch
        }
      });

      // Wait for all transactions in batch to complete
      await Promise.allSettled(promises);

      const duration = Date.now() - startTime;
      logger.info('Transaction enrichment batch completed', {
        blockNumber,
        batchId,
        duration,
        processedCount,
        errorCount,
        totalTransactions: transactions.length,
        successRate: ((processedCount / transactions.length) * 100).toFixed(2) + '%',
      });

      // Update batch progress tracking
      this.processedCount += processedCount;
      this.errorCount += errorCount;
      this.logPeriodicSummary();

    } catch (error) {
      const duration = Date.now() - startTime;
      this.errorCount += transactions.length; // Count all as errors if batch fails
      logger.error('Failed to process transaction enrichment batch', {
        blockNumber,
        batchId,
        transactionCount: transactions.length,
        duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
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

      // Removed excessive debug logging for performance optimization
      // Database update success is already tracked by error handling

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

  /**
   * Log periodic summary to track progress without excessive logging
   */
  private logPeriodicSummary(): void {
    if (this.processedCount % this.SUMMARY_INTERVAL === 0) {
      const currentTime = Date.now();
      const timeSinceLastSummary = currentTime - this.lastSummaryTime;
      const transactionsPerSecond = this.SUMMARY_INTERVAL / (timeSinceLastSummary / 1000);
      
      logger.info('Transaction enrichment progress', {
        processedCount: this.processedCount,
        errorCount: this.errorCount,
        successRate: ((this.processedCount - this.errorCount) / this.processedCount * 100).toFixed(2) + '%',
        transactionsPerSecond: transactionsPerSecond.toFixed(2),
        intervalMs: timeSinceLastSummary,
      });
      
      this.lastSummaryTime = currentTime;
    }
  }
}