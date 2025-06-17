// Monad Validator Analytics - Admin Routes
import { Router } from 'express';
import { AdminController } from '../controllers/AdminController';

export function createAdminRoutes(adminController: AdminController): Router {
  const router = Router();

  // Cache management
  router.post('/api/cache/flush', adminController.flushCache.bind(adminController));
  router.get('/api/cache/stats', adminController.getCacheStats.bind(adminController));
  router.post('/api/cache/warmup', adminController.warmupCache.bind(adminController));
  
  // Log processing management
  router.post('/api/logs/process', adminController.processLogs.bind(adminController));
  router.get('/api/ingestion/status', adminController.getIngestionStatus.bind(adminController));
  
  // Database management
  router.get('/api/database/stats', adminController.getDatabaseStats.bind(adminController));
  router.post('/api/database/optimize', adminController.optimizeDatabase.bind(adminController));
  
  // Maintenance operations
  router.get('/api/maintenance/status', adminController.getMaintenanceStatus.bind(adminController));
  router.post('/api/maintenance/perform', adminController.performMaintenance.bind(adminController));

  return router;
} 