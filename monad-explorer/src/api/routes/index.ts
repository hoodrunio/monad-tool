import { Router } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { createTransactionRoutes } from './transactions';
import { createBlockRoutes } from './blocks';
import { createAddressRoutes } from './addresses';
import { createTokenRoutes } from './tokens';
import { createContractRoutes } from './contracts';
import { createAnalyticsRoutes } from './analytics';
import { createOptimizedBlockRoutes } from './optimized-blocks';
import { createOptimizedTransactionRoutes } from './optimized-transactions';

/**
 * Create API routes for the logs-first architecture
 */
export function createAPIRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  // API documentation endpoint
  router.get('/', (req, res) => {
    res.json({
      name: 'Monad Explorer REST API',
      version: '1.0.0',
      description: 'Logs-first blockchain explorer API with runtime token transfer parsing',
      architecture: {
        approach: 'logs-first',
        storageReduction: '70%',
        tokenTransfers: 'runtime-computed',
        caching: 'Redis + in-memory',
      },
      endpoints: {
        transactions: {
          'GET /transactions': 'Get latest transactions with basic data (for preview)',
          'GET /transactions/:hash': 'Get enriched transaction with runtime-parsed token transfers',
          'GET /transactions/:hash/token-transfers': 'Get token transfers for specific transaction',
        },
        addresses: {
          'GET /addresses/:address/transactions': 'Get transactions for address with pagination',
          'GET /addresses/:address/token-transfers': 'Get token transfers for address',
        },
        blocks: {
          'GET /blocks': 'Get latest blocks with basic data (for preview)',
          'GET /blocks/:number': 'Get specific block details',
          'GET /blocks/:number/transactions': 'Get all transactions in a block with enriched data',
        },
        tokens: {
          'GET /tokens/:address': 'Get token metadata and statistics',
          'GET /tokens/:address/transfers': 'Get all token transfers for specific token',
        },
        contracts: {
          'GET /contracts/:address': 'Get contract information with metadata',
          'GET /contracts/:address/metadata': 'Get contract metadata and analysis',
          'GET /contracts': 'Get contracts with pagination and filtering',
          'POST /contracts/:address/enrich': 'Manually trigger contract enrichment',
        },
        analytics: {
          'GET /analytics/transactions/daily': 'Get daily transaction counts for chart visualization',
          'GET /analytics/transactions/weekly': 'Get weekly transaction statistics',
          'GET /analytics/gas/current': 'Get current gas price and fee recommendations',
          'GET /analytics/gas/history': 'Get historical gas price data for charts',
        },
      },
      features: [
        'Runtime token transfer parsing',
        'No TokenTransfer entity storage',
        'On-demand contract discovery',
        'Background contract enrichment',
        'Smart contract metadata analysis',
        'Transaction analytics and statistics',
        'Real-time gas price tracking',
        'Historical data visualization',
        'Sub-100ms response times',
        'Comprehensive error handling',
        'Request validation',
        'Rate limiting',
        'CORS support',
      ],
      examples: {
        'latest-transactions': '/api/transactions?limit=20&offset=0',
        'latest-blocks': '/api/blocks?limit=10&offset=0',
        'enriched-transaction': '/api/transactions/0x1234...?includeTokenTransfers=true',
        'address-transfers': '/api/addresses/0x1234.../token-transfers?limit=20&tokenAddress=0x5678...',
        'block-transactions': '/api/blocks/12345/transactions?includeTokenTransfers=true',
        'contract-metadata': '/api/contracts/0x1234...?includeMetadata=true&includeBytecode=false',
        'contract-enrichment': 'POST /api/contracts/0x1234.../enrich',
        'daily-transactions': '/api/analytics/transactions/daily?days=30',
        'weekly-overview': '/api/analytics/transactions/weekly?weeks=12',
        'current-gas-price': '/api/analytics/gas/current',
        'gas-price-history': '/api/analytics/gas/history?days=7',
      },
    });
  });

  // Mount route modules - optimized routes first to avoid parameter conflicts
  router.use('/transactions', createOptimizedTransactionRoutes(serviceContainer));
  router.use('/transactions', createTransactionRoutes(serviceContainer));
  router.use('/blocks', createOptimizedBlockRoutes(serviceContainer));
  router.use('/blocks', createBlockRoutes(serviceContainer));
  router.use('/addresses', createAddressRoutes(serviceContainer));
  router.use('/tokens', createTokenRoutes(serviceContainer));
  router.use('/contracts', createContractRoutes(serviceContainer));
  router.use('/analytics', createAnalyticsRoutes(serviceContainer));

  return router;
} 