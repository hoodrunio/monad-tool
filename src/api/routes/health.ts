// Monad Validator Analytics - Health Routes
import { Router } from 'express';
import { HealthController } from '../controllers/HealthController';

export function createHealthRoutes(healthController: HealthController): Router {
  const router = Router();

  // Basic health check
  router.get('/health', healthController.getHealth.bind(healthController));
  
  // System health endpoints
  router.get('/api/system/health', healthController.getSystemHealth.bind(healthController));
  router.get('/api/system/metrics', healthController.getSystemMetrics.bind(healthController));
  router.get('/api/system/cache', healthController.getCacheInfo.bind(healthController));
  router.get('/api/system/tables', healthController.getTableStats.bind(healthController));
  
  // Kubernetes-style probes
  router.get('/api/system/readiness', healthController.getReadiness.bind(healthController));
  router.get('/api/system/liveness', healthController.getLiveness.bind(healthController));

  return router;
} 