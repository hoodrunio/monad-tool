// Blockchain Explorer API Routes
// REST endpoints for blockchain data access

import { Router } from 'express';
import { BlockchainController } from '../controllers/BlockchainController';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';

export function createBlockchainRoutes(
  clickhouseClient: MonadClickHouseClient,
  redisClient: MonadRedisClient
): Router {
  const router = Router();
  const controller = new BlockchainController(clickhouseClient, redisClient);

  // =============================================
  // BLOCKS ENDPOINTS
  // =============================================

  /**
   * GET /api/blockchain/blocks
   * Get latest blocks with pagination
   * Query params: limit (max 100), offset
   */
  router.get('/blocks', controller.getLatestBlocks.bind(controller));

  /**
   * GET /api/blockchain/blocks/:blockNumber
   * Get specific block by number
   */
  router.get('/blocks/:blockNumber', controller.getBlockByNumber.bind(controller));

  // =============================================
  // TRANSACTIONS ENDPOINTS
  // =============================================

  /**
   * GET /api/blockchain/transactions
   * Get latest transactions with pagination
   * Query params: limit (max 100), offset
   */
  router.get('/transactions', controller.getLatestTransactions.bind(controller));

  /**
   * GET /api/blockchain/transactions/:hash
   * Get specific transaction by hash
   */
  router.get('/transactions/:hash', controller.getTransactionByHash.bind(controller));

  // =============================================
  // ACCOUNTS ENDPOINTS
  // =============================================

  /**
   * GET /api/blockchain/accounts/:address
   * Get account information by address
   */
  router.get('/accounts/:address', controller.getAccountInfo.bind(controller));

  /**
   * GET /api/blockchain/accounts/:address/transactions
   * Get transactions for specific address
   * Query params: limit (max 100), offset
   */
  router.get('/accounts/:address/transactions', controller.getAccountTransactions.bind(controller));

  // =============================================
  // TOKENS ENDPOINTS
  // =============================================

  /**
   * GET /api/blockchain/tokens
   * Get top tokens by transfer volume
   * Query params: limit (max 100)
   */
  router.get('/tokens', controller.getTopTokens.bind(controller));

  /**
   * GET /api/blockchain/tokens/:address/transfers
   * Get token transfers for specific token
   * Query params: limit (max 100)
   */
  router.get('/tokens/:address/transfers', controller.getTokenTransfers.bind(controller));

  // =============================================
  // STATS ENDPOINTS
  // =============================================

  /**
   * GET /api/blockchain/stats
   * Get network statistics
   */
  router.get('/stats', controller.getNetworkStats.bind(controller));

  // =============================================
  // SEARCH ENDPOINT
  // =============================================

  /**
   * GET /api/blockchain/search
   * Universal search for blocks, transactions, addresses
   * Query params: q (search query)
   */
  router.get('/search', controller.search.bind(controller));

  return router;
}