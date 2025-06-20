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

  // Domain mapping management
  router.get('/api/domain-mappings', adminController.getDomainMappings.bind(adminController));
  router.post('/api/domain-mappings', adminController.addDomainMapping.bind(adminController));
  router.delete('/api/domain-mappings/:hostname', adminController.removeDomainMapping.bind(adminController));
  router.get('/api/domain-mappings/:hostname/check', adminController.checkDomainMapping.bind(adminController));

  return router;
} 