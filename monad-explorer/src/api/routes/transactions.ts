import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { Transaction } from '../../model/generated';
import { ITransactionService, EnrichedTransaction } from '../../interfaces/services/ITransactionService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateTransactionHash, validatePaginationParams } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { LessThan } from 'typeorm';
import { appConfig } from '../../config/AppConfig';
import { ColdStorageQueryService } from '../../services/cold-storage/ColdStorageQueryService';
import { logger } from '../../utils/logger';
import { extractMethodInfo } from '../../utils/method-signature';

const parseBigIntSafe = (value: string | number | bigint | null | undefined): bigint => {
  if (typeof value === 'bigint') {
    return value;
  }

  if (value === null || value === undefined) {
    return 0n;
  }

  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

const mapColdResultToEnriched = (coldResult: { transaction: any; logs: any[] }): EnrichedTransaction => {
  const tx = coldResult.transaction;
  const gasPrice = parseBigIntSafe(tx.gasPrice);
  const gasUsed = parseBigIntSafe(tx.gasUsed);

  // Extract method info from input if not already present in cold storage
  const methodInfo = tx.methodId && tx.methodName
    ? { id: tx.methodId, name: tx.methodName }
    : extractMethodInfo(tx.input ?? null);

  return {
    id: tx.hash,
    hash: tx.hash,
    blockNumber: tx.blockNumber,
    transactionIndex: tx.transactionIndex ?? 0,
    fromAddress: tx.fromAddress,
    toAddress: tx.toAddress ?? null,
    value: parseBigIntSafe(tx.value),
    gas: parseBigIntSafe(tx.gas),
    gasPrice,
    gasUsed,
    status: typeof tx.status === 'number' ? tx.status : 1,
    error: null,
    revertReason: null,
    timestamp: tx.blockTimestamp instanceof Date ? tx.blockTimestamp : new Date(tx.blockTimestamp),
    input: tx.input ?? '0x',
    tokenTransfers: [],
    decodedLogs: coldResult.logs.map(log => ({
      logIndex: log.logIndex,
      address: log.address,
      decodedData: {
        topics: log.topics,
        data: log.data,
      },
    })),
    internalTransactions: [],
    methodName: methodInfo.name,
    methodID: methodInfo.id,
    isContractInteraction: Boolean(tx.isContractInteraction),
    isContractCreation: Boolean(tx.isContractCreation),
    effectiveGasPrice: gasPrice,
    transactionFee: gasPrice * gasUsed,
    contractAddress: tx.contractAddress ?? null,
  };
};

/**
 * Create transaction routes using logs-first architecture with optimized queries
 */
export function createTransactionRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /transactions
   * Get latest transactions with basic data (for preview) - OPTIMIZED
   */
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = validatePaginationParams(req.query);
    const sourceParam = typeof req.query.source === 'string' ? (req.query.source as string).toLowerCase() : 'auto';

    const config = appConfig.getConfig();
    const coldReadsEnabled = config.storage.enableColdReads;
    const shouldAttemptCold = coldReadsEnabled && (
      sourceParam === 'cold' ||
      (sourceParam === 'auto' && offset >= config.storage.coldReadOffsetThreshold) ||
      (config.storage.routingMode === 'cold-primary' && sourceParam !== 'hot')
    );

    if (shouldAttemptCold) {
      try {
        const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
        const coldResult = await coldStorageService.getTransactions(limit, offset);

        const apiResponse = prepareForApiResponse({
          transactions: coldResult.transactions,
          pagination: {
            limit,
            offset,
            total: coldResult.total,
            hasMore: coldResult.hasMore,
          }
        });

        return successResponse(res, apiResponse, 'Transactions retrieved from cold storage', 200, {
          source: 'clickhouse',
          limit,
          offset,
          totalCount: coldResult.total,
          hasMore: coldResult.hasMore,
          strategy: sourceParam,
        });
      } catch (error) {
        logger.warn('Cold storage transaction query failed, falling back to hot tier', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const store = await serviceContainer.resolve<StoreAdapter>('store');
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const cacheKey = `transactions:list:hot:${limit}:${offset}`;

    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached) {
        return successResponse(res, cached, 'Latest transactions retrieved from cache', 200, {
          source: 'cache',
          limit,
          offset,
        });
      }
    } catch (error) {
      // Cache miss or error, continue with database query
    }

    try {
      let transactions: Transaction[];
      let totalCount: number;

      if (offset > 10000) {
        const cursorCacheKey = `transactions:cursor:${offset}`;
        let cursorTimestamp: Date | undefined;

        try {
          cursorTimestamp = await cacheService.get<Date>(cursorCacheKey) ?? undefined;
        } catch (error) {
          const hoursBack = Math.floor(offset / 1000);
          cursorTimestamp = new Date(Date.now() - (hoursBack * 60 * 60 * 1000));
        }

        transactions = await store.Transaction.find({
          where: cursorTimestamp ? { timestamp: LessThan(cursorTimestamp) } : undefined,
          relations: ['block'],
          order: { timestamp: 'DESC' },
          take: limit,
        });

        if (transactions.length > 0) {
          await cacheService.set(cursorCacheKey, transactions[transactions.length - 1].timestamp, 300000);
        }
      } else {
        transactions = await store.Transaction.find({
          relations: ['block'],
          order: { timestamp: 'DESC' },
          skip: offset,
          take: limit,
        });
      }

      const totalCountCacheKey = 'transactions:total_count';

      try {
        const cachedCount = await cacheService.get<number>(totalCountCacheKey);
        if (cachedCount && typeof cachedCount === 'number') {
          totalCount = cachedCount;
        } else {
          const latestTx = await store.Transaction.findOne({
            order: { timestamp: 'DESC' },
            select: ['id']
          });

          totalCount = latestTx ? 150000000 : 0;
          await cacheService.set(totalCountCacheKey, totalCount, 300000);
        }
      } catch (error) {
        totalCount = transactions.length > 0 ? 150000000 : 0;
      }

      const basicTransactions = transactions.map((tx: Transaction) => ({
        hash: tx.hash,
        blockNumber: tx.block.number,
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        value: tx.value,
        gasUsed: tx.gasUsed,
        gasPrice: tx.gasPrice,
        timestamp: tx.timestamp,
        status: tx.status,
        error: tx.error,
        revertReason: tx.revertReason,
        isContractInteraction: tx.isContractInteraction,
        isContractCreation: tx.isContractCreation
      }));

      const apiResponse = prepareForApiResponse({
        transactions: basicTransactions,
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + limit < totalCount
        }
      });

      try {
        await cacheService.set(cacheKey, apiResponse, 15000);
      } catch (error) {
        // Cache error, but don't fail the request
      }

      successResponse(res, apiResponse, 'Latest transactions retrieved successfully', 200, {
        totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount,
        dataType: 'preview',
        source: 'database',
        optimizationUsed: offset > 10000 ? 'cursor-based' : 'traditional',
        attemptedCold: shouldAttemptCold,
        strategy: sourceParam,
      });
    } catch (error) {
      throw new ApiErrorResponse('Failed to fetch transactions', 500, 'DATABASE_ERROR');
    }
  }));

  /**
   * GET /transactions/:hash
   * Get enriched transaction with runtime-parsed token transfers - OPTIMIZED
   */
  router.get('/:hash', asyncHandler(async (req: Request, res: Response) => {
    const { hash } = req.params;
    const {
      includeTokenTransfers = 'true',
      includeTokenMetadata = 'true',
      includeDecodedLogs = 'true',
      includeInternalTransactions = 'true'
    } = req.query;

    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse(
        'Invalid transaction hash format',
        400,
        'INVALID_TRANSACTION_HASH'
      );
    }

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');
    const cacheKey = `transaction:${hash}:${includeTokenTransfers}:${includeTokenMetadata}:${includeDecodedLogs}:${includeInternalTransactions}`;

    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached) {
        return successResponse(res, cached, 'Transaction retrieved from cache', 200, {
          source: 'cache',
          architecture: 'logs-first',
          tokenTransfersComputed: true,
          tokenTransferCount: cached.tokenTransfers?.length || 0,
          decodedLogCount: cached.decodedLogs?.length || 0,
          performance: 'runtime-parsed'
        });
      }
    } catch (error) {
      // Continue with transaction service
    }

    let enrichedTx = await transactionService.getEnrichedTransaction(hash, {
      includeTokenTransfers: includeTokenTransfers === 'true',
      includeTokenMetadata: includeTokenMetadata === 'true',
      includeDecodedLogs: includeDecodedLogs === 'true',
      includeInternalTransactions: includeInternalTransactions === 'true'
    });

    const config = appConfig.getConfig();

    if (!enrichedTx && config.storage.enableColdReads) {
      try {
        const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
        const coldResult = await coldStorageService.getTransactionByHash(hash);

        if (coldResult) {
          const coldEnriched = mapColdResultToEnriched(coldResult);
          const apiResponse = prepareForApiResponse(coldEnriched);

          try {
            await cacheService.set(cacheKey, apiResponse, 120000);
          } catch (error) {
            // Cache error, continue
          }

          return successResponse(res, apiResponse, 'Transaction retrieved from cold storage', 200, {
            architecture: 'cold-storage',
            tokenTransfersComputed: false,
            tokenTransferCount: 0,
            decodedLogCount: coldResult.logs.length,
            performance: 'cold-storage',
            source: 'clickhouse'
          });
        }
      } catch (error) {
        logger.warn('Cold storage lookup failed for transaction', {
          hash,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    if (!enrichedTx) {
      throw new ApiErrorResponse(
        'Transaction not found',
        404,
        'TRANSACTION_NOT_FOUND'
      );
    }

    const apiResponse = prepareForApiResponse(enrichedTx);

    try {
      await cacheService.set(cacheKey, apiResponse, 120000);
    } catch (error) {
      // Cache error, but don't fail the request
    }

    successResponse(res, apiResponse, 'Transaction retrieved successfully', 200, {
      architecture: 'logs-first',
      tokenTransfersComputed: true,
      tokenTransferCount: enrichedTx.tokenTransfers?.length || 0,
      decodedLogCount: enrichedTx.decodedLogs?.length || 0,
      performance: 'runtime-parsed',
      source: 'database'
    });
  }));

  /**
   * GET /transactions/:hash/token-transfers
   * Get only token transfers for a specific transaction - OPTIMIZED
   */
  router.get('/:hash/token-transfers', asyncHandler(async (req: Request, res: Response) => {
    const { hash } = req.params;
    const { includeMetadata = 'false' } = req.query;

    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse(
        'Invalid transaction hash format',
        400,
        'INVALID_TRANSACTION_HASH'
      );
    }

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');

    const cacheKey = `transaction:${hash}:token-transfers:${includeMetadata}`;

    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached) {
        return successResponse(res, cached, 'Token transfers retrieved from cache', 200, {
          source: 'cache',
          architecture: 'logs-first',
          transferCount: cached.length || 0
        });
      }
    } catch (error) {
      // Continue with transaction service
    }

    let transfers;
    let dataSource = 'database';

    try {
      transfers = await transactionService.getTokenTransfersForTransaction(hash, {
        includeMetadata: includeMetadata === 'true'
      });
    } catch (error) {
      // Transaction not in hot storage, try cold storage
      const config = appConfig.getConfig();
      if (config.storage.enableColdReads) {
        try {
          logger.info('Transaction not found in hot storage for token transfers, attempting cold storage', {
            hash,
          });

          const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
          const coldResult = await coldStorageService.getTransactionByHash(hash);

          if (coldResult) {
            // Format cold storage logs for parser
            const formattedLogs = coldResult.logs.map((log: any) => ({
              id: `${log.transactionHash}-${log.logIndex}`,
              address: log.address,
              topics: log.topics,
              data: log.data,
              logIndex: log.logIndex,
              transaction: {
                hash: log.transactionHash,
                blockNumber: log.blockNumber,
                timestamp: log.blockTimestamp
              }
            }));

            // Parse token transfers using the same parser as hot storage
            const logTokenTransferParser = await serviceContainer.resolve<any>('logTokenTransferParser');
            const parsingResult = await logTokenTransferParser.parseTransfersFromLogs(
              formattedLogs,
              {
                includeTokenInfo: includeMetadata === 'true'
              }
            );

            const apiTransfers = prepareForApiResponse(parsingResult.transfers);

            try {
              await cacheService.set(cacheKey, apiTransfers, 300000);
            } catch (cacheError) {
              // Cache error, but don't fail
            }

            return successResponse(res, apiTransfers, 'Token transfers retrieved from cold storage', 200, {
              architecture: 'cold-storage',
              transferCount: parsingResult.transfers.length,
              source: 'clickhouse'
            });
          }
        } catch (coldError) {
          logger.warn('Cold storage token transfers lookup failed', {
            hash,
            error: coldError instanceof Error ? coldError.message : 'Unknown error',
          });
        }
      }

      throw new ApiErrorResponse('Transaction not found', 404, 'TRANSACTION_NOT_FOUND');
    }

    const apiTransfers = prepareForApiResponse(transfers);

    try {
      await cacheService.set(cacheKey, apiTransfers, 300000);
    } catch (error) {
      // Cache error, but don't fail the request
    }

    successResponse(res, apiTransfers, 'Token transfers retrieved successfully', 200, {
      architecture: 'logs-first',
      transferCount: transfers.length,
      source: dataSource
    });
  }));

  /**
   * GET /transactions/:hash/internal-transactions
   * Get internal transactions for a specific transaction (on-demand tracing) - OPTIMIZED
   */
  router.get('/:hash/internal-transactions', asyncHandler(async (req: Request, res: Response) => {
    const { hash } = req.params;
    const {
      includeFailedCalls = 'false',
      maxDepth = '10',
      filterByAddress = ''
    } = req.query;

    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse(
        'Invalid transaction hash format',
        400,
        'INVALID_TRANSACTION_HASH'
      );
    }

    const depth = parseInt(maxDepth as string, 10);
    if (isNaN(depth) || depth < 1 || depth > 20) {
      throw new ApiErrorResponse(
        'Invalid maxDepth parameter. Must be between 1 and 20',
        400,
        'INVALID_MAX_DEPTH'
      );
    }

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const cacheKey = `transaction:${hash}:internal:${includeFailedCalls}:${maxDepth}:${filterByAddress}`;

    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached) {
        return successResponse(res, cached, 'Internal transactions retrieved from cache', 200, {
          source: 'cache',
          internalTransactionCount: cached.length || 0
        });
      }
    } catch (error) {
      // Continue with service factory
    }

    const internalTxServiceFactory = await serviceContainer.resolve<any>('internalTransactionServiceFactory');
    const internalTxService = await internalTxServiceFactory.create();

    let internalTxs;
    let dataSource = 'database';

    try {
      internalTxs = await internalTxService.getInternalTransactions(hash, {
        includeFailedCalls: includeFailedCalls === 'true',
        maxDepth: depth,
        filterByAddress: filterByAddress ? (filterByAddress as string) : undefined
      });
    } catch (error) {
      // Transaction might be in cold storage, verify it exists
      const config = appConfig.getConfig();
      if (config.storage.enableColdReads) {
        try {
          logger.info('Transaction not found in hot storage for internal transactions, checking cold storage', {
            hash,
          });

          const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
          const coldResult = await coldStorageService.getTransactionByHash(hash);

          if (coldResult) {
            // Transaction exists in cold storage, but we still need RPC trace
            // Internal transactions require RPC trace regardless of where tx is stored
            internalTxs = await internalTxService.getInternalTransactions(hash, {
              includeFailedCalls: includeFailedCalls === 'true',
              maxDepth: depth,
              filterByAddress: filterByAddress ? (filterByAddress as string) : undefined
            });
            dataSource = 'clickhouse-verified-rpc-traced';
          }
        } catch (coldError) {
          logger.warn('Cold storage internal transactions lookup failed', {
            hash,
            error: coldError instanceof Error ? coldError.message : 'Unknown error',
          });
        }
      }

      if (!internalTxs) {
        throw new ApiErrorResponse('Transaction not found', 404, 'TRANSACTION_NOT_FOUND');
      }
    }

    const apiInternalTxs = prepareForApiResponse(internalTxs);

    try {
      await cacheService.set(cacheKey, apiInternalTxs, 600000);
    } catch (error) {
      // Cache error, but don't fail the request
    }

    successResponse(res, apiInternalTxs, 'Internal transactions retrieved successfully', 200, {
      internalTransactionCount: internalTxs.length,
      source: 'database'
    });
  }));

  /**
   * GET /transactions/:hash/has-internal-transactions
   * Quick check if transaction has internal transactions (lightweight) - OPTIMIZED
   */
  router.get('/:hash/has-internal-transactions', asyncHandler(async (req: Request, res: Response) => {
    const { hash } = req.params;

    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse(
        'Invalid transaction hash format',
        400,
        'INVALID_TRANSACTION_HASH'
      );
    }

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const cacheKey = `transaction:${hash}:has-internal`;

    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached !== null) {
        return successResponse(res, cached, 'Internal transaction check retrieved from cache', 200, {
          source: 'cache'
        });
      }
    } catch (error) {
      // Continue with service factory
    }

    const internalTxServiceFactory = await serviceContainer.resolve<any>('internalTransactionServiceFactory');
    const internalTxService = await internalTxServiceFactory.create();

    let hasInternal;
    let dataSource = 'database';

    try {
      hasInternal = await internalTxService.hasInternalTransactions(hash);
    } catch (error) {
      // Transaction might be in cold storage, verify it exists
      const config = appConfig.getConfig();
      if (config.storage.enableColdReads) {
        try {
          logger.info('Transaction not found in hot storage for internal tx check, checking cold storage', {
            hash,
          });

          const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
          const coldResult = await coldStorageService.getTransactionByHash(hash);

          if (coldResult) {
            // Transaction exists in cold storage, check via RPC
            hasInternal = await internalTxService.hasInternalTransactions(hash);
            dataSource = 'clickhouse-verified-rpc-traced';
          }
        } catch (coldError) {
          logger.warn('Cold storage internal tx check failed', {
            hash,
            error: coldError instanceof Error ? coldError.message : 'Unknown error',
          });
        }
      }

      if (hasInternal === undefined) {
        throw new ApiErrorResponse('Transaction not found', 404, 'TRANSACTION_NOT_FOUND');
      }
    }

    const response = { hasInternalTransactions: hasInternal };

    try {
      await cacheService.set(cacheKey, response, 1800000);
    } catch (error) {
      // Cache error, but don't fail the request
    }

    successResponse(res, response, 'Internal transaction check completed', 200, {
      source: dataSource
    });
  }));

  return router;
}
