import { Router } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';

export function createBlockRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  // TODO: Implement block routes with logs-first architecture
  router.get('/:number/transactions', (req, res) => {
    res.json({
      message: 'Block transactions endpoint - Coming soon with logs-first architecture',
      endpoint: `GET /api/blocks/${req.params.number}/transactions`,
      features: ['Runtime token transfer parsing', 'Enriched transaction data'],
      status: 'under-development'
    });
  });

  return router;
} 