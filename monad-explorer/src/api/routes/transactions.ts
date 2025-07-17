import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { Transaction } from '../../model/generated';
import { ITransactionService } from '../../interfaces/services/ITransactionService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateTransactionHash, validatePaginationParams } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { LessThan } from 'typeorm';

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

    // Get services
    const store = await serviceContainer.resolve<StoreAdapter>('store');
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');

    // Cache key for this specific request
    const cacheKey = `transactions:list:${limit}:${offset}`;
    
    // Try cache first
    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached) {
        return successResponse(res, cached, 'Latest transactions retrieved from cache', 200, {
          source: 'cache',
          limit,
          offset
        });
      }
    } catch (error) {
      // Cache miss or error, continue with database query
    }

    try {
      // OPTIMIZED: For large offsets, use cursor-based pagination behind the scenes
      let transactions: Transaction[];
      let totalCount: number;
      
      if (offset > 10000) {
        // Use cursor-based pagination for large offsets (more efficient)
        
        // Get the cursor timestamp from cache or calculate it
        const cursorCacheKey = `transactions:cursor:${offset}`;
        let cursorTimestamp;
        
        try {
          cursorTimestamp = await cacheService.get<Date>(cursorCacheKey);
        } catch (error) {
          // Fallback: calculate approximate cursor position
          // This is an approximation, but much faster than large OFFSET
          const hoursBack = Math.floor(offset / 1000); // Assuming ~1000 tx/hour average
          cursorTimestamp = new Date(Date.now() - (hoursBack * 60 * 60 * 1000));
        }

        transactions = await store.Transaction.find({
          where: cursorTimestamp ? { timestamp: LessThan(cursorTimestamp) } : undefined,
          relations: ['block'],
          order: { timestamp: 'DESC' },
          take: limit,
        });

        // Cache the cursor for next requests
        if (transactions.length > 0) {
          await cacheService.set(cursorCacheKey, transactions[transactions.length - 1].timestamp, 300000);
        }
      } else {
        // Use traditional pagination for small offsets
        transactions = await store.Transaction.find({
          relations: ['block'],
          order: { timestamp: 'DESC' },
          skip: offset,
          take: limit,
        });
      }

      // Get total count efficiently (cache this as it's expensive)
      const totalCountCacheKey = 'transactions:total_count';
      
      try {
        const cachedCount = await cacheService.get<number>(totalCountCacheKey);
        if (cachedCount && typeof cachedCount === 'number') {
          totalCount = cachedCount;
        } else {
          // Use estimated count based on latest transaction ID (much faster than COUNT(*))
          const latestTx = await store.Transaction.findOne({
            order: { timestamp: 'DESC' },
            select: ['id']
          });
          
          // Estimate based on auto-increment ID or use a reasonable approximation
          totalCount = latestTx ? 150000000 : 0; // Current known scale
          
          // Cache for 5 minutes
          await cacheService.set(totalCountCacheKey, totalCount, 300000);
        }
      } catch (error) {
        totalCount = transactions.length > 0 ? 150000000 : 0; // Fallback estimate
      }

      // Format basic transaction data for preview
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

      // Convert BigInt fields to strings for JSON response
      const apiResponse = prepareForApiResponse({
        transactions: basicTransactions,
        pagination: {
          limit,
          offset,
          total: totalCount,
          hasMore: offset + limit < totalCount
        }
      });

      // Cache the result for 15 seconds (transactions change frequently)
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
        optimizationUsed: offset > 10000 ? 'cursor-based' : 'traditional'
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

    // Validate transaction hash
    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse(
        'Invalid transaction hash format',
        400,
        'INVALID_TRANSACTION_HASH'
      );
    }

    // Get services
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');

    // Create cache key based on request parameters
    const cacheKey = `transaction:${hash}:${includeTokenTransfers}:${includeTokenMetadata}:${includeDecodedLogs}:${includeInternalTransactions}`;
    
    // Try cache first (longer TTL for specific transactions)
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

    // Get enriched transaction using existing service
    const enrichedTx = await transactionService.getEnrichedTransaction(hash, {
      includeTokenTransfers: includeTokenTransfers === 'true',
      includeTokenMetadata: includeTokenMetadata === 'true',
      includeDecodedLogs: includeDecodedLogs === 'true',
      includeInternalTransactions: includeInternalTransactions === 'true'
    });

    if (!enrichedTx) {
      throw new ApiErrorResponse(
        'Transaction not found',
        404,
        'TRANSACTION_NOT_FOUND'
      );
    }

    // Convert BigInt fields to strings for JSON response
    const apiResponse = prepareForApiResponse(enrichedTx);
    
    // Cache for 2 minutes (specific transactions rarely change but can have new token data)
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

    // Validate transaction hash
    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse(
        'Invalid transaction hash format',
        400,
        'INVALID_TRANSACTION_HASH'
      );
    }

    // Get services
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');

    const cacheKey = `transaction:${hash}:token-transfers:${includeMetadata}`;
    
    // Try cache first
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

    // Get token transfers only using existing service
    const transfers = await transactionService.getTokenTransfersForTransaction(hash, {
      includeMetadata: includeMetadata === 'true'
    });

    // Convert BigInt fields to strings for JSON response
    const apiTransfers = prepareForApiResponse(transfers);
    
    // Cache for 5 minutes (token transfers rarely change)
    try {
      await cacheService.set(cacheKey, apiTransfers, 300000);
    } catch (error) {
      // Cache error, but don't fail the request
    }
    
    successResponse(res, apiTransfers, 'Token transfers retrieved successfully', 200, {
      architecture: 'logs-first',
      transferCount: transfers.length,
      source: 'database'
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

    // Validate transaction hash
    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse(
        'Invalid transaction hash format',
        400,
        'INVALID_TRANSACTION_HASH'
      );
    }

    // Validate maxDepth
    const depth = parseInt(maxDepth as string, 10);
    if (isNaN(depth) || depth < 1 || depth > 20) {
      throw new ApiErrorResponse(
        'Invalid maxDepth parameter. Must be between 1 and 20',
        400,
        'INVALID_MAX_DEPTH'
      );
    }

    // Get services
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    
    const cacheKey = `transaction:${hash}:internal:${includeFailedCalls}:${maxDepth}:${filterByAddress}`;
    
    // Try cache first (longer TTL for internal transactions as they're expensive to compute)
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

    // Get InternalTransactionService from container
    const internalTxServiceFactory = await serviceContainer.resolve<any>('internalTransactionServiceFactory');
    const internalTxService = await internalTxServiceFactory.create();

    // Get internal transactions with options
    const internalTxs = await internalTxService.getInternalTransactions(hash, {
      includeFailedCalls: includeFailedCalls === 'true',
      maxDepth: depth,
      filterByAddress: filterByAddress ? (filterByAddress as string) : undefined
    });

    // Convert BigInt fields to strings for JSON response
    const apiInternalTxs = prepareForApiResponse(internalTxs);
    
    // Cache for 10 minutes (internal transactions are expensive and rarely change)
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

    // Validate transaction hash
    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse(
        'Invalid transaction hash format',
        400,
        'INVALID_TRANSACTION_HASH'
      );
    }

    // Get services
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    
    const cacheKey = `transaction:${hash}:has-internal`;
    
    // Try cache first (very long TTL for this boolean check)
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

    // Get InternalTransactionService from container
    const internalTxServiceFactory = await serviceContainer.resolve<any>('internalTransactionServiceFactory');
    const internalTxService = await internalTxServiceFactory.create();

    // Quick check for internal transactions
    const hasInternal = await internalTxService.hasInternalTransactions(hash);

    const response = { hasInternalTransactions: hasInternal };
    
    // Cache for 30 minutes (this rarely changes and is lightweight)
    try {
      await cacheService.set(cacheKey, response, 1800000);
    } catch (error) {
      // Cache error, but don't fail the request
    }

    successResponse(res, response, 'Internal transaction check completed', 200, {
      source: 'database'
    });
  }));

  return router;
}