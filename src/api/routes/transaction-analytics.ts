// Monad Validator Analytics - Transaction Analytics Routes
import { Router } from 'express';
import { TransactionAnalyticsController } from '../controllers/TransactionAnalyticsController';

export function createTransactionAnalyticsRoutes(controller: TransactionAnalyticsController): Router {
  const router = Router();

  // =============================================
  // VALIDATOR TRANSACTION ANALYTICS
  // =============================================

  // Get comprehensive transaction metrics for a specific validator
  router.get('/validator/:id', (req, res) => controller.getValidatorTransactionMetrics(req, res));
  
  // Get validator transaction trends over time
  router.get('/validator/:id/trends', (req, res) => controller.getValidatorTransactionTrends(req, res));

  // =============================================
  // NETWORK TRANSACTION ANALYTICS
  // =============================================

  // Get network-wide transaction summary
  router.get('/network/summary', (req, res) => controller.getNetworkTransactionSummary(req, res));
  
  // Get network transaction trends over time
  router.get('/network/trends', (req, res) => controller.getNetworkTransactionTrends(req, res));

  // =============================================
  // VALIDATOR RANKINGS BY TRANSACTION PERFORMANCE
  // =============================================

  // Get validator rankings by transaction processing performance
  router.get('/rankings', (req, res) => controller.getValidatorTransactionRankings(req, res));

  // =============================================
  // TPS (TRANSACTIONS PER SECOND) ANALYTICS
  // =============================================

  // Get TPS analytics with time series data
  router.get('/tps', (req, res) => controller.getTpsAnalytics(req, res));
  
  // Get current real-time TPS
  router.get('/tps/current', (req, res) => controller.getCurrentTps(req, res));

  // =============================================
  // GEOGRAPHIC & PROVIDER ANALYTICS
  // =============================================

  // Get transaction processing analytics by geographic location
  router.get('/geographic', (req, res) => controller.getGeographicTransactionAnalytics(req, res));
  
  // Get transaction processing analytics by infrastructure provider
  router.get('/providers', (req, res) => controller.getProviderTransactionAnalytics(req, res));

  return router;
} 