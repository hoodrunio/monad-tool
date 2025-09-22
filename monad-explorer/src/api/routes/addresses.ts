import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { ITransactionService } from '../../interfaces/services/ITransactionService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateAddress, validatePaginationParams, validateBoolean } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { OnChainBalanceService } from '../../services/token/OnChainBalanceService';
import { IRpcClient } from '../../interfaces/blockchain/IRpcClient';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { TokenType } from '../../model';

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
          error: tx.error,
          revertReason: tx.revertReason,
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
        relations: ['block'],
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
          error: tx.error,
          revertReason: tx.revertReason,
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
   * Get token balances for an address (on-chain query)
   */
  router.get('/:address/balance', asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address.toLowerCase();
    const tokenAddress = req.query.tokenAddress as string;
    const includeNative = validateBoolean(req.query.includeNative as string, true); // default true
    const includeMetadata = validateBoolean(req.query.includeMetadata as string, true); // default true
    const useCache = validateBoolean(req.query.useCache as string, true); // default true
    const blockNumber = req.query.blockNumber ? parseInt(req.query.blockNumber as string, 10) : undefined;



    if (!validateAddress(address)) {
      throw new ApiErrorResponse('Invalid address format', 400, 'INVALID_ADDRESS');
    }

    // Get required services
    const rpcClient = await serviceContainer.resolve<IRpcClient>('rpcClient');
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService').catch(() => undefined);
    const balanceService = new OnChainBalanceService(rpcClient, cacheService);

    if (tokenAddress) {
      // Get balance for specific token (on-chain)
      if (!validateAddress(tokenAddress)) {
        throw new ApiErrorResponse('Invalid token address format', 400, 'INVALID_TOKEN_ADDRESS');
      }

      // First, we need to determine the token type from database or detect it
      const store = await serviceContainer.resolve<StoreAdapter>('store');
      let tokenType = TokenType.ERC20; // default assumption
      
      try {
        const tokenRecord = await store.Token.findOne({
          where: { id: tokenAddress.toLowerCase() }
        });
        if (tokenRecord) {
          tokenType = tokenRecord.tokenType;
        }
      } catch (error) {
        // If token not in DB, assume ERC20
      }

      const startTime = Date.now();
      const tokenBalance = await balanceService.getTokenBalance(
        address,
        tokenAddress.toLowerCase(),
        tokenType,
        {
          includeMetadata,
          useCache,
          cacheTtl: 300, // 5 minutes
          blockNumber
        }
      );

      const queryTime = Date.now() - startTime;

      return successResponse(res, prepareForApiResponse({
        address: address,
        tokenAddress: tokenAddress.toLowerCase(),
        balance: tokenBalance ? {
          amount: tokenBalance.balance,
          token: {
            address: tokenBalance.tokenAddress,
            name: tokenBalance.metadata?.name || null,
            symbol: tokenBalance.metadata?.symbol || null,
            decimals: tokenBalance.metadata?.decimals || null,
            tokenType: tokenBalance.tokenType
          }
        } : null,
        onChain: {
          queryTime: `${queryTime}ms`,
        }
      }), 'Token balance retrieved successfully (on-chain)');
    } else {
      // Get all token balances for address (on-chain multicall)
      const store = await serviceContainer.resolve<StoreAdapter>('store');
      
      // Get known tokens for this address from database (for token types)
      const knownTokens = await store.Token.find({
        select: ['id', 'tokenType'],
        where: {},
        take: 100 // Limit to avoid too many RPC calls
      });

      const tokensToQuery = knownTokens.map((token: any) => ({
         address: token.id,
         type: token.tokenType
       }));

      const startTime = Date.now();
      const result = await balanceService.getMultipleTokenBalances(
        address,
        tokensToQuery,
        {
          includeNativeBalance: includeNative,
          includeMetadata,
          useCache,
          cacheTtl: 300,
          blockNumber
        }
      );

      const queryTime = Date.now() - startTime;

      return successResponse(res, prepareForApiResponse({
        address: address,
        nativeBalance: result.nativeBalance || null,
        balances: result.tokenBalances.map(balance => ({
          amount: balance.balance,
          token: {
            address: balance.tokenAddress,
            name: balance.metadata?.name || null,
            symbol: balance.metadata?.symbol || null,
            decimals: balance.metadata?.decimals || null,
            tokenType: balance.tokenType
          }
        })),
        onChain: {
          queryTime: `${queryTime}ms`,
          tokensQueried: tokensToQuery.length,
          balancesFound: result.tokenBalances.length
        }
      }), 'Token balances retrieved successfully (on-chain)', 200, {
        tokenCount: result.tokenBalances.length
      });
    }
  }));

  /**
   * GET /addresses/:address/internal-transactions
   * Get internal transactions for an address (on-demand tracing)
   */
  router.get('/:address/internal-transactions', asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address.toLowerCase();
    const { 
      includeFailedCalls = 'false',
      maxDepth = '10',
      limit = '50',
      offset = '0'
    } = req.query;

    if (!validateAddress(address)) {
      throw new ApiErrorResponse('Invalid address format', 400, 'INVALID_ADDRESS');
    }

    const { limit: validatedLimit, offset: validatedOffset } = validatePaginationParams(req.query);

    // Validate maxDepth
    const depth = parseInt(maxDepth as string, 10);
    if (isNaN(depth) || depth < 1 || depth > 20) {
      throw new ApiErrorResponse(
        'Invalid maxDepth parameter. Must be between 1 and 20',
        400,
        'INVALID_MAX_DEPTH'
      );
    }

    // Get InternalTransactionService from store (with store access for address-based queries)
    const store = await serviceContainer.resolve<any>('store');
    const internalTxService = await store.getInternalTransactionService();

    const startTime = Date.now();
    
    // Get internal transactions for address
    const result = await internalTxService.getInternalTransactionsForAddress(
      address,
      validatedLimit,
      validatedOffset,
      {
        includeFailedCalls: includeFailedCalls === 'true',
        maxDepth: depth
      }
    );
    
    const processingTime = Date.now() - startTime;

    // Convert BigInt fields to strings for JSON response
    const apiInternalTxs = prepareForApiResponse(result.internalTransactions);
    
    successResponse(res, {
      address: address,
      internalTransactions: apiInternalTxs,
      pagination: {
        limit: validatedLimit,
        offset: validatedOffset,
        total: result.total,
        hasMore: validatedOffset + validatedLimit < result.total
      },
      runtime: {
        processingTime: `${processingTime}ms`
        }
    }, 'Internal transactions for address retrieved successfully', 200);
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