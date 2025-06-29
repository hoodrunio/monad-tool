import { Router } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';

export function createTokenRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  // TODO: Implement token routes
  router.get('/:address', (req, res) => {
    res.json({
      message: 'Token metadata endpoint - Coming soon',
      endpoint: `GET /api/tokens/${req.params.address}`,
      features: ['Token metadata', 'Statistics', 'Enrichment status'],
      status: 'under-development'
    });
  });

  return router;
} 