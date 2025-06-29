import { Router } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';

export function createAddressRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  // TODO: Implement address routes with logs-first architecture
  router.get('/:address/transactions', (req, res) => {
    res.json({
      message: 'Address transactions endpoint - Coming soon with logs-first architecture',
      endpoint: `GET /api/addresses/${req.params.address}/transactions`,
      features: ['Runtime token transfer parsing', 'Pagination support'],
      status: 'under-development'
    });
  });

  router.get('/:address/token-transfers', (req, res) => {
    res.json({
      message: 'Address token transfers endpoint - Coming soon with logs-first architecture',
      endpoint: `GET /api/addresses/${req.params.address}/token-transfers`,
      features: ['Runtime parsing', 'No entity storage', '70% storage reduction'],
      status: 'under-development'
    });
  });

  return router;
} 