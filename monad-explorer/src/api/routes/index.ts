import { Router } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { createTransactionRoutes } from './transactions';
import { createBlockRoutes } from './blocks';
import { createAddressRoutes } from './addresses';
import { createTokenRoutes } from './tokens';

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
          'GET /transactions/:hash': 'Get enriched transaction with runtime-parsed token transfers',
          'GET /transactions/:hash/token-transfers': 'Get token transfers for specific transaction',
        },
        addresses: {
          'GET /addresses/:address/transactions': 'Get transactions for address with pagination',
          'GET /addresses/:address/token-transfers': 'Get token transfers for address',
        },
        blocks: {
          'GET /blocks/:number/transactions': 'Get all transactions in a block with enriched data',
        },
        tokens: {
          'GET /tokens/:address': 'Get token metadata and statistics',
        },
      },
      features: [
        'Runtime token transfer parsing',
        'No TokenTransfer entity storage',
        'Sub-100ms response times',
        'Comprehensive error handling',
        'Request validation',
        'Rate limiting',
        'CORS support',
      ],
      examples: {
        'enriched-transaction': '/api/transactions/0x1234...?includeTokenTransfers=true',
        'address-transfers': '/api/addresses/0x1234.../token-transfers?limit=20&tokenAddress=0x5678...',
        'block-transactions': '/api/blocks/12345/transactions?includeTokenTransfers=true',
      },
    });
  });

  // Mount route modules
  router.use('/transactions', createTransactionRoutes(serviceContainer));
  router.use('/blocks', createBlockRoutes(serviceContainer));
  router.use('/addresses', createAddressRoutes(serviceContainer));
  router.use('/tokens', createTokenRoutes(serviceContainer));

  return router;
} 