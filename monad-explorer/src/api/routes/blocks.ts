import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { Block } from '../../model/generated';
import { ITransactionService } from '../../interfaces/services/ITransactionService';
import { ParsedTokenTransfer } from '../../interfaces/processing/ILogTokenTransferParser';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateBlockNumber, validatePaginationParams, validateBoolean } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { In } from 'typeorm';

/**
 * Create block routes using logs-first architecture
 */
export function createBlockRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /blocks
   * Get latest blocks with basic data (for preview)
   */
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = validatePaginationParams(req.query);

    // Get store from container
    const store = await serviceContainer.resolve<StoreAdapter>('store');

    // Get latest blocks with basic data
    const blocks = await store.Block.find({
      order: { number: 'DESC' },
      skip: offset,
      take: limit,
    });

    // For total count, we'll use a reasonable approximation since Block interface doesn't have findAndCount
    const totalCount = blocks.length > 0 ? (blocks[0].number || 0) : 0;

    // Get transaction counts for each block
    const blocksWithTxCount = await Promise.all(
      blocks.map(async (block: Block) => {
        const txCount = await store.Transaction.find({
          where: { block: { number: block.number } },
          select: ['id']
        }).then(txs => txs.length);

        return {
          number: block.number,
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: block.timestamp,
          gasUsed: block.gasUsed,
          gasLimit: block.gasLimit,
          baseFeePerGas: block.baseFeePerGas,
          size: block.size,
          transactionCount: txCount
        };
      })
    );

    // Convert BigInt fields to strings for JSON response
    const apiResponse = prepareForApiResponse({
      blocks: blocksWithTxCount,
      pagination: {
        limit,
        offset,
        total: totalCount,
        hasMore: offset + limit < totalCount
      }
    });
    
    successResponse(res, apiResponse, 'Latest blocks retrieved successfully', 200, {
      totalCount,
      limit,
      offset,
      hasMore: offset + limit < totalCount,
      dataType: 'preview'
    });
  }));

  /**
   * GET /blocks/:number
   * Get block details
   */
  router.get('/:number', asyncHandler(async (req: Request, res: Response) => {
    const blockNumber = req.params.number;
    
    if (!validateBlockNumber(blockNumber)) {
      throw new ApiErrorResponse('Invalid block number format', 400, 'INVALID_BLOCK_NUMBER');
    }

    const store = await serviceContainer.resolve<StoreAdapter>('store');
    
    const block = await store.Block.findOne({
      where: { number: parseInt(blockNumber) },
    });

    if (!block) {
      throw new ApiErrorResponse('Block not found', 404, 'BLOCK_NOT_FOUND');
    }

    // Get transaction count for this block
    const [transactions, transactionCount] = await store.Transaction.findAndCount({
      where: { block: { number: parseInt(blockNumber) } },
      select: ['id'] // Only count, don't fetch full data
    });

    return successResponse(res, prepareForApiResponse({
      block: {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
        baseFeePerGas: block.baseFeePerGas,
        size: block.size,
        transactionCount: transactionCount
      }
    }), 'Block details retrieved successfully', 200, {
      queryTime: Date.now()
    });
  }));

  /**
   * GET /blocks/:number/transactions
   * Get all transactions in a block with optional token transfer parsing
   */
  router.get('/:number/transactions', asyncHandler(async (req: Request, res: Response) => {
    const blockNumber = req.params.number;
    const includeTokenTransfers = validateBoolean(req.query.includeTokenTransfers as string);
    const { limit, offset } = validatePaginationParams(req.query);

    if (!validateBlockNumber(blockNumber)) {
      throw new ApiErrorResponse('Invalid block number format', 400, 'INVALID_BLOCK_NUMBER');
    }

    const store = await serviceContainer.resolve<StoreAdapter>('store');
    
    // First check if block exists
    const block = await store.Block.findOne({
      where: { number: parseInt(blockNumber) },
      select: ['id', 'number', 'hash', 'timestamp']
    });

    if (!block) {
      throw new ApiErrorResponse('Block not found', 404, 'BLOCK_NOT_FOUND');
    }

    // Get transactions with pagination
    const [transactions, totalCount] = await store.Transaction.findAndCount({
      where: { block: { number: parseInt(blockNumber) } },
      order: { id: 'ASC' },
      skip: offset,
      take: limit,
    });

    if (transactions.length === 0) {
      return successResponse(res, prepareForApiResponse({
        block: {
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp
        },
        transactions: [],
        tokenTransfers: includeTokenTransfers ? [] : undefined
      }), 'No transactions found in block', 200, {
        totalCount: 0,
        limit,
        offset,
        hasMore: false
      });
    }

    let enrichedTransactions;
    let allTokenTransfers: ParsedTokenTransfer[] = [];

    if (includeTokenTransfers) {
      // Use TransactionService for enriched data with token transfers
      const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');
      
      const startTime = Date.now();
      enrichedTransactions = await Promise.all(
        transactions.map(async (tx) => {
          try {
            const enriched = await transactionService.getEnrichedTransaction(tx.hash, {
              includeTokenTransfers: true
            });
            
            if (enriched && enriched.tokenTransfers) {
              allTokenTransfers.push(...enriched.tokenTransfers);
            }
            
            return enriched ? {
              hash: enriched.hash,
              blockNumber: enriched.blockNumber,
              fromAddress: enriched.fromAddress,
              toAddress: enriched.toAddress,
              value: enriched.value,
              gasUsed: enriched.gasUsed,
              gasPrice: enriched.gasPrice,
              timestamp: enriched.timestamp,
              status: enriched.status
            } : {
              hash: tx.hash,
              blockNumber: tx.block.number,
              fromAddress: tx.fromAddress,
              toAddress: tx.toAddress,
              value: tx.value,
              gasUsed: tx.gasUsed,
              gasPrice: tx.gasPrice,
              timestamp: block.timestamp,
              status: tx.status
            };
          } catch (error) {
            // If enrichment fails, return basic transaction data
            return {
              hash: tx.hash,
              blockNumber: tx.block.number,
              fromAddress: tx.fromAddress,
              toAddress: tx.toAddress,
              value: tx.value,
              gasUsed: tx.gasUsed,
              gasPrice: tx.gasPrice,
              timestamp: block.timestamp,
              status: tx.status
            };
          }
        })
      );

      const enrichmentTime = Date.now() - startTime;

      return successResponse(res, prepareForApiResponse({
        block: {
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp
        },
        transactions: enrichedTransactions,
        tokenTransfers: allTokenTransfers,
        enrichment: {
          enabled: true,
          parseTime: `${enrichmentTime}ms`,
          transactionCount: transactions.length,
          tokenTransferCount: allTokenTransfers.length
        }
      }), 'Block transactions with token transfers retrieved successfully', 200, {
        totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount
      });
    } else {
      // Return basic transaction data without enrichment
      const basicTransactions = transactions.map(tx => ({
        hash: tx.hash,
        blockNumber: tx.block.number,
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        value: tx.value,
        gasUsed: tx.gasUsed,
        gasPrice: tx.gasPrice,
        timestamp: block.timestamp,
        status: tx.status
      }));

      return successResponse(res, prepareForApiResponse({
        block: {
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp
        },
        transactions: basicTransactions
      }), 'Block transactions retrieved successfully', 200, {
        totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount
      });
    }
  }));

  /**
   * GET /blocks/latest
   * Get latest block information
   */
  router.get('/latest', asyncHandler(async (req: Request, res: Response) => {
    const store = await serviceContainer.resolve<StoreAdapter>('store');
    
    const latestBlock = await store.Block.findOne({
      order: { number: 'DESC' },
    });

    if (!latestBlock) {
      throw new ApiErrorResponse('No blocks found', 404, 'NO_BLOCKS_FOUND');
    }

    // Get transaction count for latest block
    const transactionCount = await store.Transaction.find({
      where: { block: { number: latestBlock.number } },
      select: ['id']
    }).then(txs => txs.length);

    return successResponse(res, prepareForApiResponse({
      block: {
        number: latestBlock.number,
        hash: latestBlock.hash,
        parentHash: latestBlock.parentHash,
        timestamp: latestBlock.timestamp,
        gasUsed: latestBlock.gasUsed,
        gasLimit: latestBlock.gasLimit,
        baseFeePerGas: latestBlock.baseFeePerGas,
        size: latestBlock.size,
        transactionCount: transactionCount
      }
    }));
  }));

  /**
   * GET /blocks/:number/logs
   * Get all logs in a block (useful for debugging)
   */
  router.get('/:number/logs', asyncHandler(async (req: Request, res: Response) => {
    const blockNumber = req.params.number;
    const { limit, offset } = validatePaginationParams(req.query);

    if (!validateBlockNumber(blockNumber)) {
      throw new ApiErrorResponse('Invalid block number format', 400, 'INVALID_BLOCK_NUMBER');
    }

    const store = await serviceContainer.resolve<StoreAdapter>('store');
    
    // First get transactions for this block
    const blockTransactions = await store.Transaction.find({
      where: { block: { number: parseInt(blockNumber) } },
      select: ['id']
    });
    
    if (blockTransactions.length === 0) {
      return successResponse(res, prepareForApiResponse({
        blockNumber: parseInt(blockNumber),
        logs: []
      }), 'No logs found for block', 200, {
        totalCount: 0,
        limit,
        offset,
        hasMore: false
      });
    }

    // Then get logs for those transactions
    const transactionIds = blockTransactions.map(tx => tx.id);
    const [logs, totalCount] = await store.Log.findAndCount({
      where: { 
        transaction: { id: In(transactionIds) }
      },
      relations: ['transaction'],
      order: { id: 'ASC' },
      skip: offset,
      take: limit,
    });

    return successResponse(res, prepareForApiResponse({
      blockNumber: parseInt(blockNumber),
      logs: logs.map(log => ({
        id: log.id,
        transactionHash: log.transaction.hash,
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: log.logIndex
      }))
    }), 'Block logs retrieved successfully', 200, {
      totalCount,
      limit,
      offset,
      hasMore: offset + limit < totalCount
    });
  }));

  return router;
} 