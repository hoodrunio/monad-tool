import {
  IInternalTransactionService,
  ParsedInternalTransaction,
  TraceResult,
  TraceCallFrame,
  InternalTransactionParsingOptions,
  InternalTransactionParsingResult,
} from '../../interfaces/services/IInternalTransactionService';
import { IRpcClient } from '../../interfaces/blockchain/IRpcClient';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { logger } from '../../utils/logger';

export class InternalTransactionService implements IInternalTransactionService {
  private readonly cachePrefix = 'internal_tx:';
  private readonly defaultCacheTtl = 600; // 10 minutes

  constructor(
    private readonly rpcClient: IRpcClient,
    private readonly cacheService?: ICacheService,
    private readonly store?: any // Optional for address-based queries
  ) {}

  public async getInternalTransactions(
    txHash: string,
    options: InternalTransactionParsingOptions = {}
  ): Promise<ParsedInternalTransaction[]> {
    const startTime = Date.now();

    try {
      // Try cache first (if enabled)
      const cacheKey = this.buildCacheKey(txHash, options);
      if (this.cacheService) {
        const cached = await this.cacheService.get<ParsedInternalTransaction[]>(cacheKey);
        if (cached) {
          logger.debug('Retrieved internal transactions from cache', {
            txHash,
            count: cached.length,
            duration: Date.now() - startTime
          });
          return cached;
        }
      }

      // Get transaction details for metadata
      const [transaction, receipt] = await Promise.all([
        this.rpcClient.getTransaction(txHash),
        this.rpcClient.getTransactionReceipt(txHash)
      ]);

      if (!transaction || !receipt) {
        logger.warn('Transaction or receipt not found', { txHash });
        return [];
      }
      const receiptData = receipt as any;

      // Trace the transaction
      const trace = await this.rpcClient.traceTransaction(txHash, {
        tracer: 'callTracer',
        enableReturnData: true
      });

      const traceResult = trace as TraceResult;

      // Parse trace result
      const parsingResult = await this.parseTraceResult(
        traceResult,
        txHash,
        parseInt(receiptData.blockNumber, 16),
        new Date(), // We'd need to get block timestamp from transaction data
        options
      );

      // Cache result (if enabled)
      if (this.cacheService && parsingResult.internalTransactions.length > 0) {
        await this.cacheService.set(cacheKey, parsingResult.internalTransactions, this.defaultCacheTtl);
      }

      const duration = Date.now() - startTime;
      logger.debug('Retrieved internal transactions', {
        txHash,
        totalTraces: parsingResult.totalTraces,
        internalTransactions: parsingResult.internalTransactions.length,
        duration
      });

      return parsingResult.internalTransactions;

    } catch (error) {
      logger.error('Failed to get internal transactions', {
        txHash,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Return empty array instead of throwing, as internal txs are supplementary data
      return [];
    }
  }

  public async hasInternalTransactions(txHash: string): Promise<boolean> {
    try {
      // Quick check without full parsing
      const trace = await this.rpcClient.traceTransaction(txHash, {
        tracer: 'callTracer',
        disableMemory: true,
        disableStack: true,
        disableStorage: true,
        enableReturnData: false
      });

      const traceResult = trace as TraceResult;
      
      // If there are calls in the trace, there are internal transactions
      return !!(traceResult.calls && traceResult.calls.length > 0);

    } catch (error) {
      logger.debug('Failed to check for internal transactions', {
        txHash,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }

  public async getInternalTransactionsForAddress(
    address: string,
    limit: number = 50,
    offset: number = 0,
    options: InternalTransactionParsingOptions = {}
  ): Promise<{
    internalTransactions: ParsedInternalTransaction[];
    total: number;
  }> {
    const startTime = Date.now();

    try {
      if (!this.store) {
        throw new Error('Store not available for address-based queries');
      }

      const normalizedAddress = address.toLowerCase();

      // Get recent transactions involving this address
      const [transactions] = await this.store.Transaction.findAndCount({
        where: [
          { fromAddress: normalizedAddress },
          { toAddress: normalizedAddress }
        ],
        order: { timestamp: 'DESC' },
        take: Math.min(limit * 2, 100), // Get more txs as not all will have internal txs
        relations: ['block']
      });

      if (transactions.length === 0) {
        return { internalTransactions: [], total: 0 };
      }

      // Process transactions to find internal transactions
      const allInternalTxs: ParsedInternalTransaction[] = [];
      
      for (const tx of transactions) {
        try {
          const internalTxs = await this.getInternalTransactions(tx.hash, {
            ...options,
            filterByAddress: normalizedAddress
          });
          
          // Filter by address involvement
          const relevantInternalTxs = internalTxs.filter(itx =>
            itx.fromAddress.toLowerCase() === normalizedAddress ||
            (itx.toAddress && itx.toAddress.toLowerCase() === normalizedAddress)
          );
          
          allInternalTxs.push(...relevantInternalTxs);
        } catch (error) {
          logger.debug('Failed to get internal transactions for transaction', {
            txHash: tx.hash,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Sort by block number and trace index
      allInternalTxs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return b.blockNumber - a.blockNumber; // Newest first
        }
        return b.traceIndex - a.traceIndex;
      });

      // Apply pagination
      const paginatedInternalTxs = allInternalTxs.slice(offset, offset + limit);

      const duration = Date.now() - startTime;
      logger.debug('Retrieved internal transactions for address', {
        address: normalizedAddress,
        limit,
        offset,
        total: allInternalTxs.length,
        returned: paginatedInternalTxs.length,
        duration
      });

      return {
        internalTransactions: paginatedInternalTxs,
        total: allInternalTxs.length
      };

    } catch (error) {
      logger.error('Failed to get internal transactions for address', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return { internalTransactions: [], total: 0 };
    }
  }

  public async parseTraceResult(
    trace: TraceResult,
    txHash: string,
    blockNumber: number,
    timestamp: Date,
    options: InternalTransactionParsingOptions = {}
  ): Promise<InternalTransactionParsingResult> {
    const startTime = Date.now();
    const internalTransactions: ParsedInternalTransaction[] = [];
    const stats = {
      totalTraces: 0,
      successfulTraces: 0,
      failedTraces: 0,
      maxDepth: 0
    };

    // Parse the main call and its nested calls
    this.parseCallFrame(
      trace,
      txHash,
      blockNumber,
      timestamp,
      0, // trace index starts at 0
      0, // depth starts at 0
      undefined, // no parent for root call
      internalTransactions,
      stats,
      options
    );

    const processingTime = Date.now() - startTime;

    return {
      internalTransactions,
      totalTraces: stats.totalTraces,
      successfulTraces: stats.successfulTraces,
      failedTraces: stats.failedTraces,
      maxDepth: stats.maxDepth,
      processingTime
    };
  }

  private parseCallFrame(
    frame: TraceCallFrame,
    txHash: string,
    blockNumber: number,
    timestamp: Date,
    traceIndex: number,
    depth: number,
    parentTraceIndex: number | undefined,
    internalTransactions: ParsedInternalTransaction[],
    stats: any,
    options: InternalTransactionParsingOptions,
    currentIndex: { value: number } = { value: 0 }
  ): void {
    // Update stats
    stats.totalTraces++;
    stats.maxDepth = Math.max(stats.maxDepth, depth);

    // Check depth limit
    if (options.maxDepth && depth > options.maxDepth) {
      return;
    }

    const success = !frame.error;
    if (success) {
      stats.successfulTraces++;
    } else {
      stats.failedTraces++;
    }

    // Skip failed calls if not requested
    if (!success && !options.includeFailedCalls) {
      return;
    }

    // Skip if address filter is specified and doesn't match
    if (options.filterByAddress) {
      const filterAddress = options.filterByAddress.toLowerCase();
      const matchesFrom = frame.from.toLowerCase() === filterAddress;
      const matchesTo = frame.to && frame.to.toLowerCase() === filterAddress;
      
      if (!matchesFrom && !matchesTo) {
        // Still process nested calls in case they match
        if (frame.calls) {
          for (const call of frame.calls) {
            currentIndex.value++;
            this.parseCallFrame(
              call,
              txHash,
              blockNumber,
              timestamp,
              currentIndex.value,
              depth + 1,
              traceIndex,
              internalTransactions,
              stats,
              options,
              currentIndex
            );
          }
        }
        return;
      }
    }

    // Create internal transaction (skip depth 0 as it's the main transaction)
    if (depth > 0) {
      const internalTx: ParsedInternalTransaction = {
        id: `${txHash}-${traceIndex}`,
        transactionHash: txHash,
        traceIndex,
        type: frame.type || 'CALL',
        fromAddress: frame.from,
        toAddress: frame.to || null,
        value: BigInt(frame.value || '0'),
        gas: BigInt(frame.gas || '0'),
        gasUsed: BigInt(frame.gasUsed || '0'),
        input: frame.input || null,
        output: frame.output || null,
        error: frame.error || null,
        depth,
        blockNumber,
        timestamp,
        parentTraceIndex,
        success,
        revertReason: frame.error ? this.extractRevertReason(frame.error) : undefined
      };

      internalTransactions.push(internalTx);
    }

    // Process nested calls
    if (frame.calls) {
      for (const call of frame.calls) {
        currentIndex.value++;
        this.parseCallFrame(
          call,
          txHash,
          blockNumber,
          timestamp,
          currentIndex.value,
          depth + 1,
          depth > 0 ? traceIndex : undefined, // Parent trace index
          internalTransactions,
          stats,
          options,
          currentIndex
        );
      }
    }
  }

  private extractRevertReason(error: string): string | undefined {
    if (!error) return undefined;

    // Try to extract revert reason from error message
    // Common patterns:
    // "execution reverted: REASON"
    // "execution reverted"
    const revertMatch = error.match(/execution reverted:?\s*(.*)/i);
    if (revertMatch && revertMatch[1]) {
      return revertMatch[1].trim();
    }

    // Return first part of error if no specific pattern matches
    return error.split('\n')[0].slice(0, 100);
  }

  private buildCacheKey(txHash: string, options: InternalTransactionParsingOptions): string {
    const optionsHash = JSON.stringify({
      includeFailedCalls: options.includeFailedCalls || false,
      maxDepth: options.maxDepth || 10,
      filterByAddress: options.filterByAddress || null
    });
    
    return `${this.cachePrefix}${txHash}:${Buffer.from(optionsHash).toString('base64')}`;
  }
} 