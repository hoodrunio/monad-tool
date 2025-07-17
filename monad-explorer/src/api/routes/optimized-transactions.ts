import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateTransactionHash, validateAddress } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { DataSource } from 'typeorm';

/**
 * Optimized Transaction Routes - High Performance for Large Datasets
 * 
 * Optimizations:
 * - Cursor-based pagination for efficient large dataset navigation
 * - Uses materialized views for common queries
 * - Aggressive multi-layer caching strategy
 * - Minimal field selection to reduce data transfer
 * - Batched operations for address-based queries
 * - Index-optimized queries
 */
export function createOptimizedTransactionRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /transactions/optimized
   * Ultra-fast latest transactions using materialized view
   */
  router.get('/optimized', asyncHandler(async (req: Request, res: Response) => {
    const { limit = 20, cursor } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, 100);

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    const cacheKey = `transactions:optimized:${parsedLimit}:${cursor || 'latest'}`;
    
    // Try cache first (short cache for recent data)
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Latest transactions retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Use materialized view for fastest possible query
      let query = `
        SELECT 
          hash,
          from_address,
          to_address,
          value,
          gas_used,
          gas_price,
          timestamp,
          status,
          is_contract_interaction,
          is_contract_creation,
          block_number
        FROM latest_transactions_preview
      `;

      const params: any[] = [];
      
      if (cursor) {
        // Cursor is timestamp-based for efficient pagination
        query += ` WHERE timestamp < $1`;
        params.push(cursor);
      }
      
      query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
      params.push(parsedLimit + 1); // Get one extra to check if there are more

      const transactions = await dataSource.query(query, params);
      
      // Check if there are more transactions
      const hasMore = transactions.length > parsedLimit;
      if (hasMore) {
        transactions.pop(); // Remove the extra transaction
      }

      const nextCursor = hasMore && transactions.length > 0 
        ? transactions[transactions.length - 1].timestamp.toISOString()
        : null;

      const result = {
        transactions: transactions.map((tx: any) => ({
          hash: tx.hash,
          fromAddress: tx.from_address,
          toAddress: tx.to_address,
          value: tx.value,
          gasUsed: tx.gas_used,
          gasPrice: tx.gas_price,
          timestamp: tx.timestamp,
          status: tx.status,
          isContractInteraction: tx.is_contract_interaction,
          isContractCreation: tx.is_contract_creation,
          blockNumber: tx.block_number
        })),
        pagination: {
          limit: parsedLimit,
          hasMore,
          nextCursor
        }
      };

      // Cache for 15 seconds (frequent updates for latest transactions)
      await cacheService.set(cacheKey, result, 15000);

      return successResponse(res, prepareForApiResponse(result), 'Latest transactions retrieved successfully', 200, {
        cacheHit: false,
        source: 'materialized_view'
      });

    } catch (error) {
      throw new ApiErrorResponse('Failed to fetch optimized transactions', 500, 'OPTIMIZED_TRANSACTIONS_ERROR');
    }
  }));

  /**
   * GET /transactions/optimized/stats
   * Transaction statistics with minimal computation
   */
  router.get('/optimized/stats', asyncHandler(async (req: Request, res: Response) => {
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    const cacheKey = 'transactions:stats:summary';
    
    // Try cache first (5-minute cache)
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Transaction statistics retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Fast statistics using recent data from address_stats and daily_stats
      const [recentStats, totalStats] = await Promise.all([
        // Recent 24h statistics
        dataSource.query(`
          SELECT 
            COUNT(*) as recent_count,
            AVG(gas_price) as avg_gas_price,
            SUM(value) as total_value,
            COUNT(*) FILTER (WHERE is_contract_interaction = true) as contract_interactions
          FROM latest_transactions_preview
          WHERE timestamp >= NOW() - INTERVAL '24 hours'
        `),
        
        // Total statistics (approximate from address_stats)
        dataSource.query(`
          SELECT 
            SUM(transaction_count) as total_transactions,
            COUNT(*) as total_addresses,
            SUM(total_sent) as total_value_transferred
          FROM address_stats
          WHERE transaction_count > 0
        `)
      ]);

      const result = {
        last24Hours: {
          transactionCount: parseInt(recentStats[0].recent_count),
          avgGasPrice: recentStats[0].avg_gas_price,
          totalValue: recentStats[0].total_value,
          contractInteractions: parseInt(recentStats[0].contract_interactions)
        },
        overall: {
          totalTransactions: parseInt(totalStats[0].total_transactions || '0'),
          totalAddresses: parseInt(totalStats[0].total_addresses || '0'),
          totalValueTransferred: totalStats[0].total_value_transferred
        }
      };

      // Cache for 5 minutes
      await cacheService.set(cacheKey, result, 300000);

      return successResponse(res, prepareForApiResponse(result), 'Transaction statistics retrieved successfully', 200, {
        cacheHit: false
      });

    } catch (error) {
      throw new ApiErrorResponse('Failed to fetch transaction statistics', 500, 'TRANSACTION_STATS_ERROR');
    }
  }));

  /**
   * GET /transactions/optimized/:hash
   * Single transaction with minimal enrichment
   */
  router.get('/optimized/:hash', asyncHandler(async (req: Request, res: Response) => {
    const { hash } = req.params;
    
    if (!validateTransactionHash(hash)) {
      throw new ApiErrorResponse('Invalid transaction hash format', 400, 'INVALID_TRANSACTION_HASH');
    }

    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    const cacheKey = `transaction:${hash}:optimized`;
    
    // Try cache first (long cache for historical transactions)
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Transaction retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Single efficient query for transaction details
      const txQuery = `
        SELECT 
          t.hash,
          t.from_address,
          t.to_address,
          t.value,
          t.gas,
          t.gas_price,
          t.gas_used,
          t.status,
          t.timestamp,
          t.transaction_index,
          t.is_contract_interaction,
          t.is_contract_creation,
          t.method_name,
          t.input,
          t.error,
          t.revert_reason,
          b.number as block_number,
          b.hash as block_hash
        FROM transaction t
        JOIN block b ON t.block_id = b.id
        WHERE t.hash = $1
      `;

      const txResult = await dataSource.query(txQuery, [hash]);
      
      if (txResult.length === 0) {
        throw new ApiErrorResponse('Transaction not found', 404, 'TRANSACTION_NOT_FOUND');
      }

      const tx = txResult[0];
      const result = {
        hash: tx.hash,
        fromAddress: tx.from_address,
        toAddress: tx.to_address,
        value: tx.value,
        gas: tx.gas,
        gasPrice: tx.gas_price,
        gasUsed: tx.gas_used,
        status: tx.status,
        timestamp: tx.timestamp,
        transactionIndex: tx.transaction_index,
        isContractInteraction: tx.is_contract_interaction,
        isContractCreation: tx.is_contract_creation,
        methodName: tx.method_name,
        input: tx.input,
        error: tx.error,
        revertReason: tx.revert_reason,
        block: {
          number: tx.block_number,
          hash: tx.block_hash
        }
      };

      // Cache for 1 hour (transactions are immutable)
      await cacheService.set(cacheKey, result, 3600000);

      return successResponse(res, prepareForApiResponse(result), 'Transaction retrieved successfully', 200, {
        cacheHit: false
      });

    } catch (error) {
      if (error instanceof ApiErrorResponse) throw error;
      throw new ApiErrorResponse('Failed to fetch transaction', 500, 'TRANSACTION_FETCH_ERROR');
    }
  }));

  /**
   * GET /addresses/optimized/:address/transactions
   * Highly optimized address transaction history
   */
  router.get('/addresses/optimized/:address/transactions', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { limit = 20, cursor, type = 'all' } = req.query;
    const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, 100);

    if (!validateAddress(address)) {
      throw new ApiErrorResponse('Invalid address format', 400, 'INVALID_ADDRESS');
    }

    const normalizedAddress = address.toLowerCase();
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    const cacheKey = `address:${normalizedAddress}:transactions:${type}:${parsedLimit}:${cursor || 'latest'}`;
    
    // Try cache first
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Address transactions retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Check address stats first for quick metadata
      const addressStats = await dataSource.query(`
        SELECT transaction_count, first_seen, last_seen, is_contract
        FROM address_stats 
        WHERE address = $1
      `, [normalizedAddress]);

      // Build efficient query based on type
      let whereClause = '';
      let params = [normalizedAddress];
      
      switch (type) {
        case 'sent':
          whereClause = 'WHERE t.from_address = $1';
          break;
        case 'received':
          whereClause = 'WHERE t.to_address = $1';
          break;
        default:
          whereClause = 'WHERE (t.from_address = $1 OR t.to_address = $1)';
      }

      if (cursor) {
        whereClause += ` AND t.timestamp < $${params.length + 1}`;
        params.push(cursor as string);
      }

      const query = `
        SELECT 
          t.hash,
          t.from_address,
          t.to_address,
          t.value,
          t.gas_used,
          t.gas_price,
          t.timestamp,
          t.status,
          t.is_contract_interaction,
          b.number as block_number,
          CASE 
            WHEN t.from_address = $1 THEN 'sent'
            WHEN t.to_address = $1 THEN 'received'
            ELSE 'unknown'
          END as direction
        FROM transaction t
        JOIN block b ON t.block_id = b.id
        ${whereClause}
        ORDER BY t.timestamp DESC
        LIMIT $${(params.length + 1).toString()}
      `;

      params.push((parsedLimit + 1).toString());
      const transactions = await dataSource.query(query, params);
      
      // Check if there are more transactions
      const hasMore = transactions.length > parsedLimit;
      if (hasMore) {
        transactions.pop();
      }

      const nextCursor = hasMore && transactions.length > 0 
        ? transactions[transactions.length - 1].timestamp.toISOString()
        : null;

      const result = {
        address: normalizedAddress,
        summary: addressStats.length > 0 ? {
          totalTransactions: addressStats[0].transaction_count,
          firstSeen: addressStats[0].first_seen,
          lastSeen: addressStats[0].last_seen,
          isContract: addressStats[0].is_contract
        } : null,
        transactions: transactions.map((tx: any) => ({
          hash: tx.hash,
          fromAddress: tx.from_address,
          toAddress: tx.to_address,
          value: tx.value,
          gasUsed: tx.gas_used,
          gasPrice: tx.gas_price,
          timestamp: tx.timestamp,
          status: tx.status,
          isContractInteraction: tx.is_contract_interaction,
          blockNumber: tx.block_number,
          direction: tx.direction
        })),
        pagination: {
          limit: parsedLimit,
          hasMore,
          nextCursor,
          type
        }
      };

      // Cache for 2 minutes for active addresses, 15 minutes for inactive
      const isActive = addressStats.length > 0 && 
        new Date(addressStats[0].last_seen) > new Date(Date.now() - 24 * 60 * 60 * 1000);
      const cacheTtl = isActive ? 120000 : 900000;
      
      await cacheService.set(cacheKey, result, cacheTtl);

      return successResponse(res, prepareForApiResponse(result), 'Address transactions retrieved successfully', 200, {
        cacheHit: false,
        transactionCount: transactions.length
      });

    } catch (error) {
      throw new ApiErrorResponse('Failed to fetch address transactions', 500, 'ADDRESS_TRANSACTIONS_ERROR');
    }
  }));

  /**
   * GET /transactions/optimized/search
   * Fast transaction search with multiple criteria
   */
  router.get('/optimized/search', asyncHandler(async (req: Request, res: Response) => {
    const { 
      fromAddress, 
      toAddress, 
      minValue, 
      maxValue,
      fromDate,
      toDate,
      contractInteraction,
      limit = 20 
    } = req.query;

    const parsedLimit = Math.min(parseInt(limit as string, 10) || 20, 100);
    
    const cacheService = await serviceContainer.resolve<ICacheService>('cacheService');
    const dataSource = await serviceContainer.resolve<DataSource>('dataSource');
    
    // Build cache key from search params
    const searchParams = { fromAddress, toAddress, minValue, maxValue, fromDate, toDate, contractInteraction };
    const searchHash = Buffer.from(JSON.stringify(searchParams)).toString('base64').slice(0, 16);
    const cacheKey = `transactions:search:${searchHash}:${parsedLimit}`;
    
    // Try cache first
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return successResponse(res, cached, 'Search results retrieved from cache', 200, {
        cacheHit: true
      });
    }

    try {
      // Build dynamic query with proper indexing
      let whereConditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (fromAddress) {
        if (!validateAddress(fromAddress as string)) {
          throw new ApiErrorResponse('Invalid fromAddress format', 400, 'INVALID_FROM_ADDRESS');
        }
        whereConditions.push(`t.from_address = $${paramIndex++}`);
        params.push((fromAddress as string).toLowerCase());
      }

      if (toAddress) {
        if (!validateAddress(toAddress as string)) {
          throw new ApiErrorResponse('Invalid toAddress format', 400, 'INVALID_TO_ADDRESS');
        }
        whereConditions.push(`t.to_address = $${paramIndex++}`);
        params.push((toAddress as string).toLowerCase());
      }

      if (minValue) {
        whereConditions.push(`t.value >= $${paramIndex++}`);
        params.push(minValue);
      }

      if (maxValue) {
        whereConditions.push(`t.value <= $${paramIndex++}`);
        params.push(maxValue);
      }

      if (fromDate) {
        whereConditions.push(`t.timestamp >= $${paramIndex++}`);
        params.push(new Date(fromDate as string));
      }

      if (toDate) {
        whereConditions.push(`t.timestamp <= $${paramIndex++}`);
        params.push(new Date(toDate as string));
      }

      if (contractInteraction !== undefined) {
        whereConditions.push(`t.is_contract_interaction = $${paramIndex++}`);
        params.push(contractInteraction === 'true');
      }

      if (whereConditions.length === 0) {
        throw new ApiErrorResponse('At least one search criteria is required', 400, 'NO_SEARCH_CRITERIA');
      }

      const query = `
        SELECT 
          t.hash,
          t.from_address,
          t.to_address,
          t.value,
          t.gas_used,
          t.gas_price,
          t.timestamp,
          t.status,
          t.is_contract_interaction,
          b.number as block_number
        FROM transaction t
        JOIN block b ON t.block_id = b.id
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY t.timestamp DESC
        LIMIT $${paramIndex.toString()}
      `;

      params.push(parsedLimit);
      const transactions = await dataSource.query(query, params);

      const result = {
        searchCriteria: searchParams,
        transactionCount: transactions.length,
        transactions: transactions.map((tx: any) => ({
          hash: tx.hash,
          fromAddress: tx.from_address,
          toAddress: tx.to_address,
          value: tx.value,
          gasUsed: tx.gas_used,
          gasPrice: tx.gas_price,
          timestamp: tx.timestamp,
          status: tx.status,
          isContractInteraction: tx.is_contract_interaction,
          blockNumber: tx.block_number
        }))
      };

      // Cache search results for 5 minutes
      await cacheService.set(cacheKey, result, 300000);

      return successResponse(res, prepareForApiResponse(result), 'Transaction search completed successfully', 200, {
        cacheHit: false
      });

    } catch (error) {
      if (error instanceof ApiErrorResponse) throw error;
      throw new ApiErrorResponse('Failed to search transactions', 500, 'TRANSACTION_SEARCH_ERROR');
    }
  }));

  return router;
} 