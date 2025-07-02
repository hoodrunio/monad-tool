import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { Transaction } from '../../model/generated';
import { ITransactionService } from '../../interfaces/services/ITransactionService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateTransactionHash, validatePaginationParams } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';

/**
 * Create transaction routes using logs-first architecture
 */
export function createTransactionRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /transactions
   * Get latest transactions with basic data (for preview)
   */
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = validatePaginationParams(req.query);

    // Get store from container
    const store = await serviceContainer.resolve<StoreAdapter>('store');

    // Get latest transactions with basic data
    const [transactions, totalCount] = await store.Transaction.findAndCount({
      relations: ['block'],
      order: { timestamp: 'DESC' },
      skip: offset,
      take: limit,
    });

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
    
    successResponse(res, apiResponse, 'Latest transactions retrieved successfully', 200, {
      totalCount,
      limit,
      offset,
      hasMore: offset + limit < totalCount,
      dataType: 'preview'
    });
  }));

  /**
   * GET /transactions/:hash
   * Get enriched transaction with runtime-parsed token transfers
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

    // Get TransactionService from container
    const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');

    // Get enriched transaction
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
    
    successResponse(res, apiResponse, 'Transaction retrieved successfully', 200, {
      architecture: 'logs-first',
      tokenTransfersComputed: true,
      tokenTransferCount: enrichedTx.tokenTransfers.length,
      decodedLogCount: enrichedTx.decodedLogs.length,
      performance: 'runtime-parsed'
    });
  }));

  /**
   * GET /transactions/:hash/token-transfers
   * Get only token transfers for a specific transaction
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

    // Get TransactionService from container
    const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');

    // Get token transfers only
    const transfers = await transactionService.getTokenTransfersForTransaction(hash, {
      includeMetadata: includeMetadata === 'true'
    });

    // Convert BigInt fields to strings for JSON response
    const apiTransfers = prepareForApiResponse(transfers);
    
    successResponse(res, apiTransfers, 'Token transfers retrieved successfully', 200, {
      architecture: 'logs-first',
      transferCount: transfers.length,
      runtimeComputed: true,
      storageOptimization: '70% reduction vs entity storage'
    });
  }));

  /**
   * GET /transactions/:hash/internal-transactions
   * Get internal transactions for a specific transaction (on-demand tracing)
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

    // Get InternalTransactionService from container (no store needed for tx-specific queries)
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
    
    successResponse(res, apiInternalTxs, 'Internal transactions retrieved successfully', 200, {
      architecture: 'on-demand-tracing',
      internalTransactionCount: internalTxs.length,
      runtimeComputed: true,
      storageOptimization: '100% (not stored in DB)',
      performance: 'trace-based'
    });
  }));

  /**
   * GET /transactions/:hash/has-internal-transactions
   * Quick check if transaction has internal transactions (lightweight)
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

    // Get InternalTransactionService from container (no store needed for tx-specific queries)
    const internalTxServiceFactory = await serviceContainer.resolve<any>('internalTransactionServiceFactory');
    const internalTxService = await internalTxServiceFactory.create();

    // Quick check for internal transactions
    const hasInternal = await internalTxService.hasInternalTransactions(hash);

    successResponse(res, { hasInternalTransactions: hasInternal }, 'Internal transaction check completed', 200, {
      architecture: 'on-demand-tracing',
      performance: 'optimized-check',
      lightweight: true
    });
  }));

  return router;
}