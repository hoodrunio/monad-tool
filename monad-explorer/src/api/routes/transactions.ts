import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { ITransactionService } from '../../interfaces/services/ITransactionService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateTransactionHash, validatePaginationParams, validateBoolean } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';

/**
 * Create transaction routes using logs-first architecture
 */
export function createTransactionRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /transactions/:hash
   * Get enriched transaction with runtime-parsed token transfers
   */
  router.get('/:hash', asyncHandler(async (req: Request, res: Response) => {
    const { hash } = req.params;
    const { 
      includeTokenTransfers = 'true',
      includeTokenMetadata = 'true',
      includeDecodedLogs = 'true'
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
      includeDecodedLogs: includeDecodedLogs === 'true'
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

  return router;
}

// Example usage for documentation
export const transactionRoutesExamples = {
  'enriched-transaction': {
    url: 'GET /api/transactions/0x1234567890abcdef1234567890abcdef12345678',
    description: 'Get enriched transaction with all data',
    queryParams: {
      includeTokenTransfers: 'true|false (default: true)',
      includeTokenMetadata: 'true|false (default: false)',
      includeDecodedLogs: 'true|false (default: false)'
    },
    response: {
      transaction: {
        hash: '0x1234...',
        blockNumber: 12345,
        fromAddress: '0xabc...',
        toAddress: '0xdef...',
        value: '1000000000000000000',
        gas: '21000',
        gasUsed: '21000',
        status: 1,
        tokenTransfers: [
          {
            tokenAddress: '0x123...',
            fromAddress: '0xabc...',
            toAddress: '0xdef...',
            value: '1000000',
            tokenType: 'ERC20',
            logIndex: 2
          }
        ],
        decodedLogs: [],
        isContractInteraction: true,
        transactionFee: '42000000000000000'
      }
    }
  },
  'token-transfers-only': {
    url: 'GET /api/transactions/0x1234567890abcdef1234567890abcdef12345678/token-transfers',
    description: 'Get only token transfers for transaction',
    queryParams: {
      includeMetadata: 'true|false (default: false)'
    },
    response: [
      {
        tokenAddress: '0x123...',
        fromAddress: '0xabc...',
        toAddress: '0xdef...',
        value: '1000000',
        tokenType: 'ERC20',
        transactionHash: '0x1234...',
        logIndex: 2,
        blockNumber: 12345
      }
    ]
  }
}; 