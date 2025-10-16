// Staking Event Indexer - Usage Example
// Production-ready integration example

import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { StakingEventIndexer } from './StakingEventIndexer';
import { StakingEventController } from '../../api/controllers/StakingEventController';
import { createStakingEventsRouter } from '../../api/routes/staking-events';
import { logger } from '../../utils/logger';
import type { Express } from 'express';

/**
 * Initialize and start the staking event indexer
 *
 * @example
 * ```typescript
 * const app = express();
 * const clickhouse = new MonadClickHouseClient({...});
 *
 * await initializeStakingEventIndexer(app, clickhouse, {
 *   rpcUrl: 'https://your-rpc-endpoint.com',
 *   wsUrl: 'wss://your-ws-endpoint.com',
 *   startBlock: 1000000
 * });
 * ```
 */
export async function initializeStakingEventIndexer(
  app: Express,
  clickhouse: MonadClickHouseClient,
  config: {
    rpcUrl: string;
    wsUrl?: string;
    startBlock?: number;
    enableWebSocket?: boolean;
    enablePolling?: boolean;
  }
): Promise<StakingEventIndexer> {
  try {
    logger.info('🔧 Initializing Staking Event Indexer...');

    // Initialize ClickHouse schema (creates tables if they don't exist)
    await clickhouse.initializeSchema();
    logger.info('✅ ClickHouse schema initialized');

    // Create indexer
    const indexer = new StakingEventIndexer(clickhouse, {
      rpcUrl: config.rpcUrl,
      wsUrl: config.wsUrl,
      startBlock: config.startBlock || 0,
      pollingInterval: 2000, // 2 seconds
      batchSize: 1000, // blocks per query
      reconnectDelay: 5000, // 5 seconds
      maxReconnectAttempts: 10,
      enableWebSocket: config.enableWebSocket !== false,
      enablePolling: config.enablePolling !== false
    });

    // Create controller and routes
    const controller = new StakingEventController(clickhouse, indexer);
    const router = createStakingEventsRouter(controller);

    // Mount routes
    app.use('/api/staking', router);
    logger.info('✅ API routes mounted at /api/staking');

    // Start indexer
    await indexer.start();
    logger.info('✅ Staking Event Indexer started successfully');

    // Setup graceful shutdown
    const shutdown = async () => {
      logger.info('🛑 Shutting down Staking Event Indexer...');
      await indexer.stop();
      logger.info('✅ Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return indexer;
  } catch (error) {
    logger.error('❌ Failed to initialize Staking Event Indexer', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw error;
  }
}

/**
 * Standalone script example
 *
 * Run with: npx ts-node src/services/staking-events/example-usage.ts
 */
async function main() {
  const clickhouse = new MonadClickHouseClient({
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    max_open_connections: 10,
    max_query_timeout: 60000,
    compression: true
  });

  const indexer = new StakingEventIndexer(clickhouse, {
    rpcUrl: process.env.RPC_URL || 'https://your-rpc-endpoint.com',
    wsUrl: process.env.WS_URL || 'wss://your-ws-endpoint.com',
    startBlock: parseInt(process.env.START_BLOCK || '0'),
    enableWebSocket: true,
    enablePolling: true
  });

  try {
    await clickhouse.initializeSchema();
    await indexer.start();

    logger.info('🚀 Staking Event Indexer is running');
    logger.info('📊 View metrics at any time by calling indexer.getMetrics()');

    // Log metrics every 60 seconds
    setInterval(() => {
      const metrics = indexer.getMetrics();
      logger.info('📊 Indexer Metrics', metrics);
    }, 60000);

  } catch (error) {
    logger.error('Failed to start indexer', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    logger.error('Fatal error', { error });
    process.exit(1);
  });
}

/**
 * API Endpoints Available:
 *
 * GET /api/staking/events
 *   - Query params: limit, type, validator, delegator
 *   - Returns: List of staking events
 *
 * GET /api/staking/validators/:id/delegations
 *   - Returns: All delegations for a validator
 *
 * GET /api/staking/delegators/:address/delegations
 *   - Returns: All delegations by a delegator
 *
 * GET /api/staking/delegations/history
 *   - Query params: limit, validator, delegator, action
 *   - Returns: Delegation history
 *
 * GET /api/staking/rewards
 *   - Query params: limit, validator, delegator, type
 *   - Returns: Reward events
 *
 * GET /api/staking/stats
 *   - Query params: window (1h, 24h, 7d)
 *   - Returns: Staking statistics
 *
 * GET /api/staking/indexer/status
 *   - Returns: Indexer status and metrics
 */
