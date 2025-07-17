import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateBlockNumber, validatePaginationParams, validateBoolean } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { DataSource } from 'typeorm';

/**
 * Optimized Block Routes - High Performance for Large Datasets
 * 
 * Optimizations:
 * - Uses materialized views for common queries
 * - Implements cursor-based pagination for large datasets
 * - Aggressive caching with Redis
 * - Minimal data fetching with specific projections
 * - Batch operations to avoid N+1 queries
 */
export function createOptimizedBlockRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /blocks/optimized
   * Ultra-fast latest blocks with pre-computed transaction counts
   */
  router.get('/optimized', asyncHandler(async (req: Request, res: Response) => {
    const { limit = 20, cursor } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, 100);

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    // Cache key includes cursor for different pages
    const cacheKey = `blocks:optimized:${parsedLimit}:${cursor || 'latest'}`;
    
    // Try cache first
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Latest blocks retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Use materialized view for fastest possible query
      let query = `
        SELECT 
          number,
          hash,
          parent_hash,
          timestamp,
          gas_used,
          gas_limit,
          base_fee_per_gas,
          size,
          transaction_count
        FROM latest_blocks_with_stats
      `;

      const params: any[] = [];
      
      if (cursor) {
        query += ` WHERE number < $1`;
        params.push(parseInt(cursor as string, 10));
      }
      
      query += ` ORDER BY number DESC LIMIT $${params.length + 1}`;
      params.push(parsedLimit + 1); // Get one extra to check if there are more

      const blocks = await dataSource.query(query, params);
      
      // Check if there are more blocks
      const hasMore = blocks.length > parsedLimit;
      if (hasMore) {
        blocks.pop(); // Remove the extra block
      }

      const nextCursor = hasMore && blocks.length > 0 ? blocks[blocks.length - 1].number : null;

      const result = {
        blocks: blocks.map((block: any) => ({
          number: block.number,
          hash: block.hash,
          parentHash: block.parent_hash,
          timestamp: block.timestamp,
          gasUsed: block.gas_used,
          gasLimit: block.gas_limit,
          baseFeePerGas: block.base_fee_per_gas,
          size: block.size,
          transactionCount: block.transaction_count
        })),
        pagination: {
          limit: parsedLimit,
          hasMore,
          nextCursor
        }
      };

      // Cache for 30 seconds (frequent updates)
      await cacheService.set(cacheKey, result, 30000);

      return successResponse(res, prepareForApiResponse(result), 'Latest blocks retrieved successfully', 200, {
        cacheHit: false,
        source: 'materialized_view'
      });

    } catch (error) {
      throw new ApiErrorResponse('Failed to fetch optimized blocks', 500, 'OPTIMIZED_BLOCKS_ERROR');
    }
  }));

  /**
   * GET /blocks/optimized/stats
   * Block statistics without heavy computation
   */
  router.get('/optimized/stats', asyncHandler(async (req: Request, res: Response) => {
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    const cacheKey = 'blocks:stats:summary';
    
    // Try cache first (5-minute cache)
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Block statistics retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Fast aggregation query using block_stats table
      const stats = await dataSource.query(`
        SELECT 
          MAX(block_number) as latest_block,
          COUNT(*) as total_blocks,
          SUM(transaction_count) as total_transactions,
          AVG(transaction_count) as avg_transactions_per_block,
          SUM(total_gas_used) as total_gas_used,
          AVG(avg_gas_price) as avg_gas_price
        FROM block_stats
        WHERE block_number >= (SELECT MAX(block_number) - 10000 FROM block_stats)
      `);

      const result = {
        latestBlock: stats[0].latest_block,
        totalBlocks: parseInt(stats[0].total_blocks),
        totalTransactions: parseInt(stats[0].total_transactions),
        avgTransactionsPerBlock: parseFloat(stats[0].avg_transactions_per_block),
        totalGasUsed: stats[0].total_gas_used,
        avgGasPrice: stats[0].avg_gas_price
      };

      // Cache for 5 minutes
      await cacheService.set(cacheKey, result, 300000);

      return successResponse(res, prepareForApiResponse(result), 'Block statistics retrieved successfully', 200, {
        cacheHit: false
      });

    } catch (error) {
      throw new ApiErrorResponse('Failed to fetch block statistics', 500, 'BLOCK_STATS_ERROR');
    }
  }));

  /**
   * GET /blocks/optimized/:number
   * Single block with optimized transaction count
   */
  router.get('/optimized/:number', asyncHandler(async (req: Request, res: Response) => {
    const blockNumber = req.params.number;
    
    if (!validateBlockNumber(blockNumber)) {
      throw new ApiErrorResponse('Invalid block number format', 400, 'INVALID_BLOCK_NUMBER');
    }

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    const cacheKey = `block:${blockNumber}:optimized`;
    
    // Try cache first (long cache for historical blocks)
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Block retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Single query to get block with transaction count
      const blockQuery = `
        SELECT 
          b.number,
          b.hash,
          b.parent_hash,
          b.timestamp,
          b.gas_used,
          b.gas_limit,
          b.base_fee_per_gas,
          b.size,
          COALESCE(bs.transaction_count, 0) as transaction_count
        FROM block b
        LEFT JOIN block_stats bs ON b.number = bs.block_number
        WHERE b.number = $1
      `;

      const blockResult = await dataSource.query(blockQuery, [parseInt(blockNumber)]);
      
      if (blockResult.length === 0) {
        throw new ApiErrorResponse('Block not found', 404, 'BLOCK_NOT_FOUND');
      }

      const block = blockResult[0];
      const result = {
        number: block.number,
        hash: block.hash,
        parentHash: block.parent_hash,
        timestamp: block.timestamp,
        gasUsed: block.gas_used,
        gasLimit: block.gas_limit,
        baseFeePerGas: block.base_fee_per_gas,
        size: block.size,
        transactionCount: block.transaction_count
      };

      // Cache for 1 hour for historical blocks, 30 seconds for recent blocks
      const isRecent = block.number > (await getLatestBlockNumber(dataSource)) - 10;
      const cacheTtl = isRecent ? 30000 : 3600000;
      
      await cacheService.set(cacheKey, result, cacheTtl);

      return successResponse(res, prepareForApiResponse(result), 'Block retrieved successfully', 200, {
        cacheHit: false
      });

    } catch (error) {
      if (error instanceof ApiErrorResponse) throw error;
      throw new ApiErrorResponse('Failed to fetch block', 500, 'BLOCK_FETCH_ERROR');
    }
  }));

  /**
   * GET /blocks/optimized/:number/transactions/preview
   * Fast transaction preview for a block (limited fields)
   */
  router.get('/optimized/:number/transactions/preview', asyncHandler(async (req: Request, res: Response) => {
    const blockNumber = req.params.number;
    const { limit = 20, cursor } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, 100);

    if (!validateBlockNumber(blockNumber)) {
      throw new ApiErrorResponse('Invalid block number format', 400, 'INVALID_BLOCK_NUMBER');
    }

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    const cacheKey = `block:${blockNumber}:transactions:preview:${parsedLimit}:${cursor || 'latest'}`;
    
    // Try cache first
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Block transactions retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Efficient query with minimal fields and cursor pagination
      let query = `
        SELECT 
          t.hash,
          t.from_address,
          t.to_address,
          t.value,
          t.gas_used,
          t.gas_price,
          t.status,
          t.timestamp,
          t.is_contract_interaction,
          t.transaction_index
        FROM transaction t
        JOIN block b ON t.block_id = b.id
        WHERE b.number = $1
      `;

      const params = [parseInt(blockNumber)];
      
      if (cursor) {
        query += ` AND t.transaction_index > $2`;
        params.push(parseInt(cursor as string, 10));
      }
      
      query += ` ORDER BY t.transaction_index ASC LIMIT $${params.length + 1}`;
      params.push(parsedLimit + 1);

      const transactions = await dataSource.query(query, params);
      
      // Check if there are more transactions
      const hasMore = transactions.length > parsedLimit;
      if (hasMore) {
        transactions.pop();
      }

      const nextCursor = hasMore && transactions.length > 0 
        ? transactions[transactions.length - 1].transaction_index 
        : null;

      const result = {
        blockNumber: parseInt(blockNumber),
        transactions: transactions.map((tx: any) => ({
          hash: tx.hash,
          fromAddress: tx.from_address,
          toAddress: tx.to_address,
          value: tx.value,
          gasUsed: tx.gas_used,
          gasPrice: tx.gas_price,
          status: tx.status,
          timestamp: tx.timestamp,
          isContractInteraction: tx.is_contract_interaction,
          transactionIndex: tx.transaction_index
        })),
        pagination: {
          limit: parsedLimit,
          hasMore,
          nextCursor
        }
      };

      // Cache for 2 minutes
      await cacheService.set(cacheKey, result, 120000);

      return successResponse(res, prepareForApiResponse(result), 'Block transactions retrieved successfully', 200, {
        cacheHit: false,
        transactionCount: transactions.length
      });

    } catch (error) {
      throw new ApiErrorResponse('Failed to fetch block transactions', 500, 'BLOCK_TRANSACTIONS_ERROR');
    }
  }));

  /**
   * GET /blocks/optimized/range
   * Get blocks in a range efficiently
   */
  router.get('/optimized/range', asyncHandler(async (req: Request, res: Response) => {
    const { start, end, limit = 100 } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string, 10) || 100, 1000);

    if (!start || !end) {
      throw new ApiErrorResponse('Start and end block numbers are required', 400, 'MISSING_RANGE_PARAMS');
    }

    const startBlock = parseInt(start as string, 10);
    const endBlock = parseInt(end as string, 10);

    if (isNaN(startBlock) || isNaN(endBlock) || startBlock > endBlock) {
      throw new ApiErrorResponse('Invalid block range', 400, 'INVALID_BLOCK_RANGE');
    }

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    const cacheKey = `blocks:range:${startBlock}:${endBlock}:${parsedLimit}`;
    
    // Try cache first
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Block range retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Efficient range query
      const query = `
        SELECT 
          b.number,
          b.hash,
          b.timestamp,
          b.gas_used,
          b.gas_limit,
          COALESCE(bs.transaction_count, 0) as transaction_count
        FROM block b
        LEFT JOIN block_stats bs ON b.number = bs.block_number
        WHERE b.number >= $1 AND b.number <= $2
        ORDER BY b.number DESC
        LIMIT $3
      `;

      const blocks = await dataSource.query(query, [startBlock, endBlock, parsedLimit]);

      const result = {
        startBlock,
        endBlock,
        actualCount: blocks.length,
        requestedLimit: parsedLimit,
        blocks: blocks.map((block: any) => ({
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp,
          gasUsed: block.gas_used,
          gasLimit: block.gas_limit,
          transactionCount: block.transaction_count
        }))
      };

      // Cache for 5 minutes
      await cacheService.set(cacheKey, result, 300000);

      return successResponse(res, prepareForApiResponse(result), 'Block range retrieved successfully', 200, {
        cacheHit: false
      });

    } catch (error) {
      throw new ApiErrorResponse('Failed to fetch block range', 500, 'BLOCK_RANGE_ERROR');
    }
  }));

  return router;
}

/**
 * Helper function to get latest block number
 */
async function getLatestBlockNumber(dataSource: DataSource): Promise<number> {
  const result = await dataSource.query('SELECT MAX(number) as latest FROM block');
  return result[0]?.latest || 0;
} 