import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { ITransactionService } from '../../interfaces/services/ITransactionService';
import { ParsedTokenTransfer } from '../../interfaces/processing/ILogTokenTransferParser';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateAddress, validatePaginationParams, validateBoolean } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';

/**
 * Create address routes using logs-first architecture
 */
export function createAddressRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /addresses/:address/transactions
   * Get transactions for an address (from/to) with optional token transfer parsing
   */
  router.get('/:address/transactions', asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address.toLowerCase();
    const includeTokenTransfers = validateBoolean(req.query.includeTokenTransfers as string);
    const { limit, offset } = validatePaginationParams(req.query);

    if (!validateAddress(address)) {
      throw new ApiErrorResponse('Invalid address format', 400, 'INVALID_ADDRESS');
    }

    if (includeTokenTransfers) {
      // Use TransactionService for enriched data with token transfers
      const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');
      
      const startTime = Date.now();
      const result = await transactionService.getEnrichedTransactionsForAddress(
        address,
        limit,
        offset,
        { includeTokenTransfers: true }
      );
      
      const enrichmentTime = Date.now() - startTime;

      return successResponse(res, prepareForApiResponse({
        address: address,
        transactions: result.transactions.map(tx => ({
          hash: tx.hash,
          blockNumber: tx.blockNumber,
          fromAddress: tx.fromAddress,
          toAddress: tx.toAddress,
          value: tx.value,
          gasUsed: tx.gasUsed,
          gasPrice: tx.gasPrice,
          timestamp: tx.timestamp,
          status: tx.status,
          isContractInteraction: tx.isContractInteraction,
          tokenTransfers: tx.tokenTransfers
        })),
        enrichment: {
          enabled: true,
          parseTime: `${enrichmentTime}ms`,
          transactionCount: result.transactions.length,
          tokenTransferCount: result.transactions.reduce((acc, tx) => acc + tx.tokenTransfers.length, 0)
        }
      }), 'Address transactions with token transfers retrieved successfully', 200, {
        totalCount: result.total,
        limit,
        offset,
        hasMore: offset + limit < result.total
      });
    } else {
      // Use basic store queries without enrichment
      const store = await serviceContainer.resolve<StoreAdapter>('store');
      
      const [transactions, totalCount] = await store.Transaction.findAndCount({
        where: [
          { fromAddress: address },
          { toAddress: address }
        ],
        order: { timestamp: 'DESC' },
        skip: offset,
        take: limit,
      });

      return successResponse(res, prepareForApiResponse({
        address: address,
        transactions: transactions.map(tx => ({
          hash: tx.hash,
          blockNumber: tx.block.number,
          fromAddress: tx.fromAddress,
          toAddress: tx.toAddress,
          value: tx.value,
          gasUsed: tx.gasUsed,
          gasPrice: tx.gasPrice,
          timestamp: tx.timestamp,
          status: tx.status,
          isContractInteraction: tx.isContractInteraction
        }))
      }), 'Address transactions retrieved successfully', 200, {
        totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount
      });
    }
  }));

  /**
   * GET /addresses/:address/token-transfers
   * Get token transfers for an address using logs-first architecture
   */
  router.get('/:address/token-transfers', asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address.toLowerCase();
    const tokenAddress = req.query.tokenAddress as string;
    const { limit, offset } = validatePaginationParams(req.query);

    if (!validateAddress(address)) {
      throw new ApiErrorResponse('Invalid address format', 400, 'INVALID_ADDRESS');
    }

    if (tokenAddress && !validateAddress(tokenAddress)) {
      throw new ApiErrorResponse('Invalid token address format', 400, 'INVALID_TOKEN_ADDRESS');
    }

    // Use TransactionService for runtime-parsed token transfers
    const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');
    
    const startTime = Date.now();
    const result = await transactionService.getTokenTransfersForAddress(
      address,
      tokenAddress?.toLowerCase(),
      limit,
      offset,
      { includeMetadata: true }
    );
    
    const parseTime = Date.now() - startTime;

        return successResponse(res, prepareForApiResponse({
      address: address,
      tokenAddress: tokenAddress || null,
      tokenTransfers: result.transfers.map(transfer => ({
        transactionHash: transfer.transactionHash,
        blockNumber: transfer.blockNumber,
        logIndex: transfer.logIndex,
        fromAddress: transfer.fromAddress,
        toAddress: transfer.toAddress,
        tokenAddress: transfer.tokenAddress,
        value: transfer.value,
        tokenType: transfer.tokenType,
        timestamp: transfer.timestamp,
        tokenMetadata: transfer.tokenMetadata
      })),
      runtime: {
        parseTime: `${parseTime}ms`,
        transferCount: result.transfers.length,
        approach: 'logs-first',
        storageReduction: '70%'
      }
    }), 'Token transfers retrieved successfully', 200, {
      totalCount: result.total,
      limit,
      offset,
      hasMore: offset + limit < result.total
    });
  }));

  /**
   * GET /addresses/:address/balance
   * Get token balances for an address
   */
  router.get('/:address/balance', asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address.toLowerCase();
    const tokenAddress = req.query.tokenAddress as string;

    if (!validateAddress(address)) {
      throw new ApiErrorResponse('Invalid address format', 400, 'INVALID_ADDRESS');
    }

    const store = await serviceContainer.resolve<StoreAdapter>('store');
    
    if (tokenAddress) {
      // Get balance for specific token
      if (!validateAddress(tokenAddress)) {
        throw new ApiErrorResponse('Invalid token address format', 400, 'INVALID_TOKEN_ADDRESS');
      }

      const tokenBalance = await store.TokenBalance.findOne({
        where: { 
          account: { id: address },
          token: { id: tokenAddress.toLowerCase() }
        },
        relations: ['token']
      });

      return successResponse(res, prepareForApiResponse({
         address: address,
         tokenAddress: tokenAddress.toLowerCase(),
         balance: tokenBalance ? {
           amount: tokenBalance.balance,
           token: {
             address: tokenBalance.token.id,
             name: tokenBalance.token.name,
             symbol: tokenBalance.token.symbol,
             decimals: tokenBalance.token.decimals,
             tokenType: tokenBalance.token.tokenType
           }
         } : null
       }), 'Token balance retrieved successfully');
    } else {
      // Get all token balances for address
      const tokenBalances = await store.TokenBalance.find({
        where: { account: { id: address } },
        relations: ['token'],
        order: { balance: 'DESC' }
      });

      return successResponse(res, prepareForApiResponse({
         address: address,
         balances: tokenBalances.map(balance => ({
           amount: balance.balance,
           token: {
             address: balance.token.id,
             name: balance.token.name,
             symbol: balance.token.symbol,
             decimals: balance.token.decimals,
             tokenType: balance.token.tokenType
           }
         }))
       }), 'Token balances retrieved successfully', 200, {
         tokenCount: tokenBalances.length
       });
    }
  }));

  /**
   * GET /addresses/:address/stats
   * Get address statistics
   */
  router.get('/:address/stats', asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address.toLowerCase();

    if (!validateAddress(address)) {
      throw new ApiErrorResponse('Invalid address format', 400, 'INVALID_ADDRESS');
    }

    const store = await serviceContainer.resolve<StoreAdapter>('store');
    
    // Get transaction counts
    const [sentTransactions, receivedTransactions] = await Promise.all([
      store.Transaction.find({
        where: { fromAddress: address },
        select: ['id']
      }),
      store.Transaction.find({
        where: { toAddress: address },
        select: ['id']
      })
    ]);

    // Get token balance count
    const tokenBalances = await store.TokenBalance.find({
      where: { account: { id: address } },
      select: ['id']
    });

    // Get first and last transaction dates
    const [firstTx, lastTx] = await Promise.all([
      store.Transaction.findOne({
        where: [
          { fromAddress: address },
          { toAddress: address }
        ],
        order: { timestamp: 'ASC' }
      }),
      store.Transaction.findOne({
        where: [
          { fromAddress: address },
          { toAddress: address }
        ],
        order: { timestamp: 'DESC' }
      })
    ]);

    return successResponse(res, prepareForApiResponse({
      address: address,
      stats: {
        transactionCount: {
          sent: sentTransactions.length,
          received: receivedTransactions.length,
          total: sentTransactions.length + receivedTransactions.length
        },
        tokenBalanceCount: tokenBalances.length,
        firstTransactionDate: firstTx?.timestamp || null,
        lastTransactionDate: lastTx?.timestamp || null,
        isActive: !!lastTx
      }
    }), 'Address statistics retrieved successfully');
  }));

  return router;
} 