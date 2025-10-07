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
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { logger } from '../../utils/logger';
import { appConfig } from '../../config/AppConfig';
import { ColdStorageQueryService } from '../../services/cold-storage/ColdStorageQueryService';

/**
 * Create block routes using logs-first architecture with optimized queries
 */
export function createBlockRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /blocks
   * Get latest blocks with basic data (for preview) - OPTIMIZED
   */
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = validatePaginationParams(req.query);

    // Get services with error handling
    let store: StoreAdapter;
    let cacheService: ICacheService | null = null;
    
    try {
      store = await serviceContainer.resolve<StoreAdapter>('store');
    } catch (error) {
      logger.error('Failed to resolve store service', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw new ApiErrorResponse('Database service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }
    
    try {
      cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    } catch (error) {
      logger.warn('Cache service unavailable - continuing without cache', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
    
    // Cache key for this specific request
    const cacheKey = `blocks:list:${limit}:${offset}`;
    
    // Try cache first (if available)
    if (cacheService) {
      try {
        const cached = await cacheService.get<any>(cacheKey);
        if (cached) {
          return successResponse(res, cached, 'Latest blocks retrieved from cache', 200, {
            source: 'cache',
            limit,
            offset
          });
        }
      } catch (error) {
        logger.warn('Cache read failed - continuing with database query', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    try {
      const config = appConfig.getConfig();
      const coldReadsEnabled = config.storage.enableColdReads;

      // Get latest blocks with basic data
      let blocks = await store.Block.find({
        order: { number: 'DESC' },
        skip: offset,
        take: limit,
      });

      // If hot storage is empty or has very few results, try cold storage
      if (coldReadsEnabled && blocks.length === 0) {
        try {
          logger.info('Hot storage returned no blocks, attempting cold storage fallback', {
            limit,
            offset,
          });

          const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
          const coldResult = await coldStorageService.getBlocks(limit, offset);

          if (coldResult.blocks.length > 0) {
            const apiResponse = prepareForApiResponse({
              blocks: coldResult.blocks,
              pagination: {
                limit,
                offset,
                total: coldResult.total,
                hasMore: coldResult.hasMore,
              }
            });

            if (cacheService) {
              try {
                await cacheService.set(cacheKey, apiResponse, 30000);
              } catch (error) {
                logger.warn('Failed to cache cold storage response', { error });
              }
            }

            return successResponse(res, apiResponse, 'Blocks retrieved from cold storage', 200, {
              source: 'clickhouse',
              limit,
              offset,
              totalCount: coldResult.total,
              hasMore: coldResult.hasMore,
            });
          }
        } catch (error) {
          logger.warn('Cold storage blocks query failed, returning empty result', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      // Get total count efficiently (cache this separately as it's expensive)
      const totalCountCacheKey = 'blocks:total_count';
      let totalCount;

      if (cacheService) {
        try {
          totalCount = await cacheService.get<number>(totalCountCacheKey);
        } catch (error) {
          logger.warn('Failed to get total count from cache', { error });
        }
      }

      if (!totalCount) {
        try {
          // Use latest block number as approximation (much faster than COUNT(*))
          const latestBlock = await store.Block.findOne({
            order: { number: 'DESC' },
            select: ['number']
          });
          totalCount = latestBlock?.number || 0;

          // Cache for 1 minute (if cache available)
          if (cacheService) {
            try {
              await cacheService.set(totalCountCacheKey, totalCount, 60000);
            } catch (error) {
              logger.warn('Failed to cache total count', { error });
            }
          }
        } catch (error) {
          totalCount = blocks.length > 0 ? blocks[0].number : 0;
        }
      }

      // OPTIMIZED: Batch query for transaction counts to avoid N+1
      const blockIds = blocks.map(block => block.id);
      let transactionCounts: Map<string, number> = new Map();
      
      if (blockIds.length > 0) {
        try {
          // Get all transaction counts in a single query with proper relations
          const txCountsQuery = await store.Transaction.find({
            where: { block: { id: In(blockIds) } },
            relations: ['block'],
            select: ['id', 'block']
          });
          
          // Count transactions per block
          for (const tx of txCountsQuery) {
            if (tx.block && tx.block.id) {
              const blockId = tx.block.id;
              transactionCounts.set(blockId, (transactionCounts.get(blockId) || 0) + 1);
            }
          }
        } catch (error) {
          logger.warn('Failed to get transaction counts - using zero counts', {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Format response to match existing API structure
      const blocksWithTxCount = blocks.map((block: Block) => ({
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
        baseFeePerGas: block.baseFeePerGas,
        size: block.size,
        transactionCount: transactionCounts.get(block.id) || 0,
        miner: block.miner,
        extraData: block.extraData
      }));

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

      // Cache the result for 30 seconds (if cache available)
      if (cacheService) {
        try {
          await cacheService.set(cacheKey, apiResponse, 30000);
        } catch (error) {
          logger.warn('Failed to cache response', { error });
        }
      }
      
      successResponse(res, apiResponse, 'Latest blocks retrieved successfully', 200, {
        totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount,
        dataType: 'preview',
        source: 'database'
      });
    } catch (error) {
      logger.error('Database query failed in blocks route', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace'
      });
      throw new ApiErrorResponse('Failed to fetch blocks', 500, 'DATABASE_ERROR');
    }
  }));

  /**
   * GET /blocks/latest
   * Get latest block information - OPTIMIZED
   */
  router.get('/latest', asyncHandler(async (req: Request, res: Response) => {
    // Get services with error handling
    let store: StoreAdapter;
    let cacheService: ICacheService | null = null;
    
    try {
      store = await serviceContainer.resolve<StoreAdapter>('store');
    } catch (error) {
      logger.error('Failed to resolve store service', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw new ApiErrorResponse('Database service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }
    
    try {
      cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    } catch (error) {
      logger.warn('Cache service unavailable - continuing without cache', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
    
    const cacheKey = 'blocks:latest';
    
    // Try cache first (very short TTL for latest block) - if available
    if (cacheService) {
      try {
        const cached = await cacheService.get<any>(cacheKey);
        if (cached) {
          return successResponse(res, cached, 'Latest block retrieved from cache', 200, {
            source: 'cache'
          });
        }
      } catch (error) {
        logger.warn('Cache read failed - continuing with database query', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    const latestBlock = await store.Block.findOne({
      order: { number: 'DESC' },
    });

    if (!latestBlock) {
      throw new ApiErrorResponse('No blocks found', 404, 'NO_BLOCKS_FOUND');
    }

    // OPTIMIZED: Get transaction count for latest block efficiently
    const transactionCount = await store.Transaction.find({
      where: { block: { id: latestBlock.id } },
      select: ['id']
    }).then(txs => txs.length);

    const response = prepareForApiResponse({
      block: {
        number: latestBlock.number,
        hash: latestBlock.hash,
        parentHash: latestBlock.parentHash,
        timestamp: latestBlock.timestamp,
        gasUsed: latestBlock.gasUsed,
        gasLimit: latestBlock.gasLimit,
        baseFeePerGas: latestBlock.baseFeePerGas,
        size: latestBlock.size,
        transactionCount: transactionCount,
        miner: latestBlock.miner,
        extraData: latestBlock.extraData
      }
    });

    // Cache for 10 seconds (latest block changes frequently) - if available
    if (cacheService) {
      try {
        await cacheService.set(cacheKey, response, 10000);
      } catch (error) {
        logger.warn('Failed to cache response', { error });
      }
    }

    return successResponse(res, response, 'Latest block retrieved successfully', 200, {
      source: 'database'
    });
  }));

  /**
   * GET /blocks/:number
   * Get block details - OPTIMIZED
   */
  router.get('/:number', asyncHandler(async (req: Request, res: Response) => {
    const blockNumber = req.params.number;
    
    if (!validateBlockNumber(blockNumber)) {
      throw new ApiErrorResponse('Invalid block number format', 400, 'INVALID_BLOCK_NUMBER');
    }

    // Get services with error handling
    let store: StoreAdapter;
    let cacheService: ICacheService | null = null;
    
    try {
      store = await serviceContainer.resolve<StoreAdapter>('store');
    } catch (error) {
      logger.error('Failed to resolve store service', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw new ApiErrorResponse('Database service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }
    
    try {
      cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    } catch (error) {
      logger.warn('Cache service unavailable - continuing without cache', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
    
    const cacheKey = `blocks:${blockNumber}`;
    
    // Try cache first (longer TTL for specific blocks) - if available
    if (cacheService) {
      try {
        const cached = await cacheService.get<any>(cacheKey);
        if (cached) {
          return successResponse(res, cached, 'Block details retrieved from cache', 200, {
            source: 'cache',
            queryTime: Date.now()
          });
        }
      } catch (error) {
        logger.warn('Cache read failed - continuing with database query', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    let block = await store.Block.findOne({
      where: { number: parseInt(blockNumber) },
    });

    let transactionCount = 0;
    let dataSource = 'database';

    if (!block) {
      // Try cold storage if enabled
      const config = appConfig.getConfig();
      if (config.storage.enableColdReads) {
        try {
          logger.info('Block not found in hot storage, attempting cold storage lookup', {
            blockNumber,
          });

          const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
          const coldBlock = await coldStorageService.getBlockByNumber(parseInt(blockNumber));

          if (coldBlock) {
            const response = prepareForApiResponse({
              block: coldBlock
            });

            if (cacheService) {
              try {
                await cacheService.set(cacheKey, response, 300000);
              } catch (error) {
                logger.warn('Failed to cache cold storage block', { error });
              }
            }

            return successResponse(res, response, 'Block details retrieved from cold storage', 200, {
              queryTime: Date.now(),
              source: 'clickhouse'
            });
          }
        } catch (error) {
          logger.warn('Cold storage block lookup failed', {
            blockNumber,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      throw new ApiErrorResponse('Block not found', 404, 'BLOCK_NOT_FOUND');
    }

    // OPTIMIZED: Get transaction count efficiently using block id
    transactionCount = await store.Transaction.find({
      where: { block: { id: block.id } },
      select: ['id']
    }).then(txs => txs.length);

    const response = prepareForApiResponse({
      block: {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
        baseFeePerGas: block.baseFeePerGas,
        size: block.size,
        transactionCount: transactionCount,
        miner: block.miner,
        extraData: block.extraData
      }
    });

    // Cache for 5 minutes (specific blocks rarely change) - if available
    if (cacheService) {
      try {
        await cacheService.set(cacheKey, response, 300000);
      } catch (error) {
        logger.warn('Failed to cache response', { error });
      }
    }

    return successResponse(res, response, 'Block details retrieved successfully', 200, {
      queryTime: Date.now(),
      source: 'database'
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
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    
    const cacheKey = `blocks:${blockNumber}:transactions:${limit}:${offset}:${includeTokenTransfers}`;
    
    // Try cache first
    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached && cached.pagination) {
        return successResponse(res, cached, 'Block transactions retrieved from cache', 200, {
          source: 'cache',
          totalCount: cached.pagination.total,
          limit,
          offset,
          hasMore: cached.pagination.hasMore,
          queryTime: Date.now()
        });
      }
    } catch (error) {
      // Continue with database query
    }

    // First check if block exists
    let block = await store.Block.findOne({
      where: { number: parseInt(blockNumber) },
      select: ['id', 'number', 'hash', 'timestamp']
    });

    // If block not found in hot storage, try cold storage
    if (!block) {
      const config = appConfig.getConfig();
      if (config.storage.enableColdReads) {
        try {
          logger.info('Block not found in hot storage for transactions, attempting cold storage lookup', {
            blockNumber,
          });

          const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
          const coldResult = await coldStorageService.getBlockTransactions(
            parseInt(blockNumber),
            limit,
            offset
          );

          if (coldResult.block) {
            const response = prepareForApiResponse({
              block: coldResult.block,
              transactions: coldResult.transactions,
              pagination: {
                limit,
                offset,
                total: coldResult.totalCount,
                hasMore: coldResult.hasMore,
              }
            });

            if (cacheService) {
              try {
                await cacheService.set(cacheKey, response, 60000);
              } catch (error) {
                logger.warn('Failed to cache cold storage block transactions', { error });
              }
            }

            return successResponse(res, response, 'Block transactions retrieved from cold storage', 200, {
              totalCount: coldResult.totalCount,
              limit,
              offset,
              hasMore: coldResult.hasMore,
              source: 'clickhouse'
            });
          }
        } catch (error) {
          logger.warn('Cold storage block transactions lookup failed', {
            blockNumber,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      throw new ApiErrorResponse('Block not found', 404, 'BLOCK_NOT_FOUND');
    }

    // Get transactions with pagination
    const [transactions, totalCount] = await store.Transaction.findAndCount({
      where: { block: { number: parseInt(blockNumber) } },
      relations: ['block'],
      order: { id: 'ASC' },
      skip: offset,
      take: limit,
    });

    if (transactions.length === 0) {
      const response = prepareForApiResponse({
        block: {
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp
        },
        transactions: [],
        tokenTransfers: includeTokenTransfers ? [] : undefined
      });

      // Cache for 1 minute (no transactions means no change)
      try {
        await cacheService.set(cacheKey, response, 60000);
      } catch (error) {
        // Cache error, but don't fail the request
      }

      return successResponse(res, response, 'No transactions found in block', 200, {
        totalCount: 0,
        limit,
        offset,
        hasMore: false,
        source: 'database'
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
              status: enriched.status,
              error: enriched.error,
              revertReason: enriched.revertReason
            } : {
              hash: tx.hash,
              blockNumber: tx.block.number,
              fromAddress: tx.fromAddress,
              toAddress: tx.toAddress,
              value: tx.value,
              gasUsed: tx.gasUsed,
              gasPrice: tx.gasPrice,
              timestamp: block.timestamp,
              status: tx.status,
              error: tx.error,
              revertReason: tx.revertReason
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
              status: tx.status,
              error: tx.error,
              revertReason: tx.revertReason
            };
          }
        })
      );

      const enrichmentTime = Date.now() - startTime;

      const response = prepareForApiResponse({
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
      });

      // Cache for 1 minute (transactions with token transfers change frequently)
      try {
        await cacheService.set(cacheKey, response, 60000);
      } catch (error) {
        // Cache error, but don't fail the request
      }

      return successResponse(res, response, 'Block transactions with token transfers retrieved successfully', 200, {
        totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount,
        source: 'database'
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
        status: tx.status,
        error: tx.error,
        revertReason: tx.revertReason
      }));

      const response = prepareForApiResponse({
        block: {
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp
        },
        transactions: basicTransactions
      });

      // Cache for 1 minute (basic transactions change frequently)
      try {
        await cacheService.set(cacheKey, response, 60000);
      } catch (error) {
        // Cache error, but don't fail the request
      }

      return successResponse(res, response, 'Block transactions retrieved successfully', 200, {
        totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount,
        source: 'database'
      });
    }
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
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    
    const cacheKey = `blocks:${blockNumber}:logs:${limit}:${offset}`;
    
    // Try cache first
    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached && typeof cached.totalCount !== 'undefined') {
        return successResponse(res, cached, 'Block logs retrieved from cache', 200, {
          source: 'cache',
          totalCount: cached.totalCount,
          limit,
          offset,
          hasMore: cached.hasMore,
          queryTime: Date.now()
        });
      }
    } catch (error) {
      // Continue with database query
    }

    // First get transactions for this block
    const blockTransactions = await store.Transaction.find({
      where: { block: { number: parseInt(blockNumber) } },
      select: ['id']
    });

    if (blockTransactions.length === 0) {
      // Try cold storage if enabled
      const config = appConfig.getConfig();
      if (config.storage.enableColdReads) {
        try {
          logger.info('Block has no transactions in hot storage, attempting cold storage logs lookup', {
            blockNumber,
          });

          const coldStorageService = await serviceContainer.resolve<ColdStorageQueryService>('coldStorageQueryService');
          const coldResult = await coldStorageService.getBlockLogs(
            parseInt(blockNumber),
            limit,
            offset
          );

          if (coldResult.logs.length > 0) {
            const response = prepareForApiResponse({
              blockNumber: parseInt(blockNumber),
              logs: coldResult.logs.map(log => ({
                transactionHash: log.transactionHash,
                address: log.address,
                topics: log.topics,
                data: log.data,
                logIndex: log.logIndex
              })),
              totalCount: coldResult.totalCount,
              hasMore: coldResult.hasMore
            });

            if (cacheService) {
              try {
                await cacheService.set(cacheKey, response, 60000);
              } catch (error) {
                logger.warn('Failed to cache cold storage logs', { error });
              }
            }

            return successResponse(res, response, 'Block logs retrieved from cold storage', 200, {
              totalCount: coldResult.totalCount,
              limit,
              offset,
              hasMore: coldResult.hasMore,
              source: 'clickhouse'
            });
          }
        } catch (error) {
          logger.warn('Cold storage block logs lookup failed', {
            blockNumber,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      const response = prepareForApiResponse({
        blockNumber: parseInt(blockNumber),
        logs: [],
        totalCount: 0,
        hasMore: false
      });

      // Cache for 1 minute (no logs means no change)
      try {
        await cacheService.set(cacheKey, response, 60000);
      } catch (error) {
        // Cache error, but don't fail the request
      }

      return successResponse(res, response, 'No logs found for block', 200, {
        totalCount: 0,
        limit,
        offset,
        hasMore: false,
        source: 'database'
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

    const response = prepareForApiResponse({
      blockNumber: parseInt(blockNumber),
      logs: logs.map(log => ({
        id: log.id,
        transactionHash: log.transaction.hash,
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: log.logIndex
      })),
      totalCount,
      hasMore: offset + limit < totalCount
    });

    // Cache for 1 minute (logs change frequently)
    try {
      await cacheService.set(cacheKey, response, 60000);
    } catch (error) {
      // Cache error, but don't fail the request
    }

    return successResponse(res, response, 'Block logs retrieved successfully', 200, {
      totalCount,
      limit,
      offset,
      hasMore: offset + limit < totalCount,
      source: 'database'
    });
  }));

  return router;
} 