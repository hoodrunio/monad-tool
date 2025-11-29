/**
 * Monad Validator Analytics - Tip Revenue API Routes
 */
import { Router } from 'express';
import { TipRevenueController } from '../controllers/TipRevenueController';

export function createTipRevenueRoutes(controller: TipRevenueController): Router {
  const router = Router();

  // =============================================
  // NETWORK-WIDE TIP REVENUE ENDPOINTS
  // =============================================

  /**
   * GET /api/tip-revenue/rankings
   * Get validators ranked by tip revenue
   * Query params:
   *   - window: Time window (1h, 24h, 7d, 30d) - default: 24h
   *   - limit: Number of results per page (max 100) - default: 50
   *   - page: Page number - default: 1
   *   - sortBy: Sort field (total_tip, avg_tip_per_block, blocks_proposed) - default: total_tip
   */
  router.get('/rankings', controller.getTipRevenueRankings.bind(controller));

  /**
   * GET /api/tip-revenue/network/summary
   * Get network-wide tip revenue summary for last 24 hours
   */
  router.get('/network/summary', controller.getNetworkTipSummary.bind(controller));

  /**
   * GET /api/tip-revenue/trends
   * Get tip revenue trends over time
   * Query params:
   *   - hours: Number of hours (max 168) - default: 24
   */
  router.get('/trends', controller.getTipRevenueTrends.bind(controller));

  // =============================================
  // SYNC SERVICE ENDPOINTS
  // =============================================

  /**
   * GET /api/tip-revenue/sync/status
   * Get sync service status
   */
  router.get('/sync/status', controller.getSyncStatus.bind(controller));

  /**
   * POST /api/tip-revenue/sync/force
   * Force a sync
   */
  router.post('/sync/force', controller.forceSyncUpdate.bind(controller));

  return router;
}

/**
 * Create validator tip revenue routes
 * These routes are mounted under /api/validators/:id
 */
export function createValidatorTipRevenueRoutes(controller: TipRevenueController): Router {
  const router = Router({ mergeParams: true });

  /**
   * GET /api/validators/:id/tip-revenue
   * Get tip revenue for a specific validator
   * Query params:
   *   - window: Time window (1h, 24h, 7d, 30d) - default: 24h
   */
  router.get('/tip-revenue', controller.getValidatorTipRevenue.bind(controller));

  /**
   * GET /api/validators/:id/tip-revenue/history
   * Get tip revenue history for a specific validator
   * Query params:
   *   - hours: Number of hours (max 168) - default: 24
   *   - granularity: 'hourly' or 'daily' - default: hourly
   */
  router.get('/tip-revenue/history', controller.getValidatorTipHistory.bind(controller));

  return router;
}
