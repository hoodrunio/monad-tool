import { 
  ITransactionService, 
  EnrichedTransaction, 
  TransactionQueryOptions 
} from '../../interfaces/services/ITransactionService';
import { ILogTokenTransferParser, ParsedTokenTransfer } from '../../interfaces/processing/ILogTokenTransferParser';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { logger } from '../../utils/logger';

export class TransactionService implements ITransactionService {
  private readonly cachePrefix = 'tx:enriched';
  private readonly defaultCacheTtl = 300; // 5 minutes

  constructor(
    private readonly store: any, // Subsquid store/database
    private readonly logTokenTransferParser: ILogTokenTransferParser,
    private readonly cacheService?: ICacheService
  ) {}

  public async getEnrichedTransaction(
    hash: string,
    options: TransactionQueryOptions = {}
  ): Promise<EnrichedTransaction | null> {
    const startTime = Date.now();
    
    try {
      // Try cache first (if enabled)
      const cacheKey = this.buildCacheKey(hash, options);
      if (this.cacheService) {
        const cached = await this.cacheService.get<EnrichedTransaction>(cacheKey);
        if (cached) {
          logger.debug('Retrieved enriched transaction from cache', {
            hash,
            cacheHit: true,
            duration: Date.now() - startTime
          });
          return cached;
        }
      }

      // Get base transaction data
      const transaction = await this.store.Transaction.findOne({
        where: { hash },
        relations: ['block']
      });

      if (!transaction) {
        return null;
      }

      // Get logs for this transaction
      const logs = await this.store.Log.find({
        where: { transaction: { hash } },
        order: { logIndex: 'ASC' },
        relations: ['transaction']
      });

      // Build enriched transaction
      const enrichedTx = await this.buildEnrichedTransaction(transaction, logs, options);

      // Cache result (if enabled)
      if (this.cacheService && enrichedTx) {
        await this.cacheService.set(cacheKey, enrichedTx, this.defaultCacheTtl);
      }

      const duration = Date.now() - startTime;
      logger.debug('Retrieved enriched transaction', {
        hash,
        tokenTransfers: enrichedTx?.tokenTransfers.length || 0,
        decodedLogs: enrichedTx?.decodedLogs.length || 0,
        duration
      });

      return enrichedTx;

    } catch (error) {
      logger.error('Failed to get enriched transaction', {
        hash,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  public async getEnrichedTransactionsForBlock(
    blockNumber: number,
    options: TransactionQueryOptions = {}
  ): Promise<EnrichedTransaction[]> {
    const startTime = Date.now();

    try {
      // Get all transactions for the block
      const transactions = await this.store.Transaction.find({
        where: { block: { number: blockNumber } },
        order: { transactionIndex: 'ASC' },
        relations: ['block']
      });

      if (transactions.length === 0) {
        return [];
      }

      // Get all logs for these transactions
      const transactionHashes = transactions.map((tx: any) => tx.hash);
      const logs = await this.store.Log.find({
        where: { 
          transaction: { 
            hash: { $in: transactionHashes } 
          } 
        },
        order: { transaction: 'ASC', logIndex: 'ASC' },
        relations: ['transaction']
      });

      // Group logs by transaction hash
      const logsByTxHash = this.groupLogsByTransaction(logs);

      // Build enriched transactions
      const enrichedTransactions: EnrichedTransaction[] = [];
      for (const transaction of transactions) {
        const txLogs = logsByTxHash.get(transaction.hash) || [];
        const enrichedTx = await this.buildEnrichedTransaction(transaction, txLogs, options);
        if (enrichedTx) {
          enrichedTransactions.push(enrichedTx);
        }
      }

      const duration = Date.now() - startTime;
      logger.debug('Retrieved enriched transactions for block', {
        blockNumber,
        transactionCount: enrichedTransactions.length,
        totalTokenTransfers: enrichedTransactions.reduce((sum, tx) => sum + tx.tokenTransfers.length, 0),
        duration
      });

      return enrichedTransactions;

    } catch (error) {
      logger.error('Failed to get enriched transactions for block', {
        blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  public async getEnrichedTransactionsForAddress(
    address: string,
    limit: number = 20,
    offset: number = 0,
    options: TransactionQueryOptions = {}
  ): Promise<{ transactions: EnrichedTransaction[]; total: number }> {
    const startTime = Date.now();

    try {
      const normalizedAddress = address.toLowerCase();

      // Get transactions where address is from or to
      const [transactions, total] = await this.store.Transaction.findAndCount({
        where: [
          { fromAddress: normalizedAddress },
          { toAddress: normalizedAddress }
        ],
        order: { timestamp: 'DESC' },
        skip: offset,
        take: limit,
        relations: ['block']
      });

      if (transactions.length === 0) {
        return { transactions: [], total: 0 };
      }

      // Get logs for these transactions
      const transactionHashes = transactions.map((tx: any) => tx.hash);
      const logs = await this.store.Log.find({
        where: { 
          transaction: { 
            hash: { $in: transactionHashes } 
          } 
        },
        order: { transaction: 'ASC', logIndex: 'ASC' },
        relations: ['transaction']
      });

      // Group logs by transaction hash
      const logsByTxHash = this.groupLogsByTransaction(logs);

      // Build enriched transactions
      const enrichedTransactions: EnrichedTransaction[] = [];
      for (const transaction of transactions) {
        const txLogs = logsByTxHash.get(transaction.hash) || [];
        const enrichedTx = await this.buildEnrichedTransaction(transaction, txLogs, options);
        if (enrichedTx) {
          enrichedTransactions.push(enrichedTx);
        }
      }

      const duration = Date.now() - startTime;
      logger.debug('Retrieved enriched transactions for address', {
        address: normalizedAddress,
        limit,
        offset,
        total,
        returned: enrichedTransactions.length,
        duration
      });

      return { transactions: enrichedTransactions, total };

    } catch (error) {
      logger.error('Failed to get enriched transactions for address', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  public async getTokenTransfersForTransaction(
    hash: string,
    options: { includeMetadata?: boolean } = {}
  ): Promise<ParsedTokenTransfer[]> {
    try {
      // Get logs for this transaction
      const logs = await this.store.Log.find({
        where: { transaction: { hash } },
        order: { logIndex: 'ASC' },
        relations: ['transaction', 'transaction.block']
      });

      if (logs.length === 0) {
        return [];
      }

      // Parse token transfers from logs
      const parsingResult = await this.logTokenTransferParser.parseTransfersFromLogs(
        logs.map((log: any) => ({
          id: log.id,
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
          transaction: {
            hash: log.transaction.hash,
            blockNumber: log.transaction.block.number,
            timestamp: log.transaction.timestamp
          }
        })),
        {
          includeTokenInfo: options.includeMetadata || false
        }
      );

      return parsingResult.transfers;

    } catch (error) {
      logger.error('Failed to get token transfers for transaction', {
        hash,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  public async getTokenTransfersForAddress(
    address: string,
    tokenAddress?: string,
    limit: number = 50,
    offset: number = 0,
    options: { includeMetadata?: boolean } = {}
  ): Promise<{ transfers: ParsedTokenTransfer[]; total: number }> {
    const startTime = Date.now();

    try {
      const normalizedAddress = address.toLowerCase();
      
      // Build query for logs that might be token transfers involving this address
      const transferSignatures = this.logTokenTransferParser.getSupportedSignatures();
      
      let whereConditions: any = {
        topics: { $elemMatch: { $in: transferSignatures } }
      };

      // If token address is specified, filter by it
      if (tokenAddress) {
        whereConditions.address = tokenAddress.toLowerCase();
      }

      // Get logs that are token transfers
      const [logs, totalLogs] = await this.store.Log.findAndCount({
        where: whereConditions,
        order: { transaction: 'DESC', logIndex: 'ASC' },
        skip: offset,
        take: limit * 2, // Get more logs to account for filtering
        relations: ['transaction', 'transaction.block']
      });

      if (logs.length === 0) {
        return { transfers: [], total: 0 };
      }

      // Parse token transfers from logs
      const parsingResult = await this.logTokenTransferParser.parseTransfersFromLogs(
        logs.map((log: any) => ({
          id: log.id,
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
          transaction: {
            hash: log.transaction.hash,
            blockNumber: log.transaction.block.number,
            timestamp: log.transaction.timestamp
          }
        })),
        {
          includeTokenInfo: options.includeMetadata || false
        }
      );

      // Filter transfers that involve the specified address
      const relevantTransfers = parsingResult.transfers.filter(transfer => 
        transfer.fromAddress.toLowerCase() === normalizedAddress ||
        transfer.toAddress.toLowerCase() === normalizedAddress
      );

      // Apply pagination to the filtered results
      const paginatedTransfers = relevantTransfers.slice(0, limit);

      const duration = Date.now() - startTime;
      logger.debug('Retrieved token transfers for address', {
        address: normalizedAddress,
        tokenAddress,
        limit,
        offset,
        totalLogs,
        relevantTransfers: relevantTransfers.length,
        returned: paginatedTransfers.length,
        duration
      });

      return { 
        transfers: paginatedTransfers, 
        total: relevantTransfers.length 
      };

    } catch (error) {
      logger.error('Failed to get token transfers for address', {
        address,
        tokenAddress,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  private async buildEnrichedTransaction(
    transaction: any,
    logs: any[],
    options: TransactionQueryOptions
  ): Promise<EnrichedTransaction | null> {
    try {
      const enrichedTx: EnrichedTransaction = {
        // Base transaction data
        id: transaction.id,
        hash: transaction.hash,
        blockNumber: transaction.block.number,
        transactionIndex: transaction.transactionIndex,
        fromAddress: transaction.fromAddress,
        toAddress: transaction.toAddress,
        value: transaction.value,
        gas: transaction.gas,
        gasPrice: transaction.gasPrice,
        gasUsed: transaction.gasUsed,
        status: transaction.status,
        timestamp: transaction.timestamp,
        input: transaction.input,

        // Metadata
        methodName: transaction.methodName,
        methodID: transaction.methodID,
        isContractInteraction: transaction.isContractInteraction,
        isContractCreation: transaction.isContractCreation,
        effectiveGasPrice: transaction.effectiveGasPrice,
        transactionFee: transaction.transactionFee,

        // Enriched data (computed at runtime)
        tokenTransfers: [],
        decodedLogs: []
      };

      // Parse token transfers if requested
      if (options.includeTokenTransfers !== false && logs.length > 0) {
        const parsingResult = await this.logTokenTransferParser.parseTransfersFromLogs(
          logs.map(log => ({
            id: log.id,
            address: log.address,
            topics: log.topics,
            data: log.data,
            logIndex: log.logIndex,
            transaction: {
              hash: transaction.hash,
              blockNumber: transaction.block.number,
              timestamp: transaction.timestamp
            }
          })),
          {
            includeTokenInfo: options.includeTokenMetadata || false
          }
        );

        enrichedTx.tokenTransfers = parsingResult.transfers;
      }

      // Decode logs if requested
      if (options.includeDecodedLogs && logs.length > 0) {
        enrichedTx.decodedLogs = logs.map(log => ({
          logIndex: log.logIndex,
          address: log.address,
          eventSignature: log.topics[0] || undefined,
          // TODO: Add actual log decoding logic here
          eventName: this.getEventName(log.topics[0]),
          decodedData: undefined // Would be populated by a log decoder service
        }));
      }

      return enrichedTx;

    } catch (error) {
      logger.error('Failed to build enriched transaction', {
        transactionHash: transaction.hash,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  private groupLogsByTransaction(logs: any[]): Map<string, any[]> {
    const logsByTxHash = new Map<string, any[]>();
    
    for (const log of logs) {
      const txHash = log.transaction.hash;
      if (!logsByTxHash.has(txHash)) {
        logsByTxHash.set(txHash, []);
      }
      logsByTxHash.get(txHash)!.push(log);
    }
    
    return logsByTxHash;
  }

  private buildCacheKey(hash: string, options: TransactionQueryOptions): string {
    const optionsHash = JSON.stringify(options);
    return `${this.cachePrefix}:${hash}:${optionsHash}`;
  }

  private getEventName(signature?: string): string | undefined {
    if (!signature) return undefined;
    
    // Common event signatures
    const eventNames = new Map([
      ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', 'Transfer'],
      ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', 'Approval'],
      ['0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', 'TransferSingle'],
      ['0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb', 'TransferBatch'],
      ['0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31', 'ApprovalForAll'],
    ]);

    return eventNames.get(signature);
  }
} 