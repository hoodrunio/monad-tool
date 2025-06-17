// Monad Validator Analytics - Query Performance Routes
// Routes for monitoring ClickHouse query performance and database health

import { Router } from 'express';
import { QueryPerformanceController } from '../controllers/QueryPerformanceController';

export function createQueryPerformanceRoutes(controller: QueryPerformanceController): Router {
  const router = Router();

  /**
   * @route GET /api/query-performance/recent
   * @desc Get recent query performance metrics
   * @access Public
   * @params 
   *   - hours (optional): Number of hours to look back (default: 1)
   *   - limit (optional): Maximum number of queries to return (default: 50)
   */
  router.get('/api/query-performance/recent', controller.getRecentPerformance.bind(controller));

  /**
   * @route GET /api/query-performance/slow
   * @desc Get slow queries above threshold
   * @access Public
   * @params
   *   - threshold (optional): Minimum duration in ms (default: 1000)
   *   - hours (optional): Number of hours to look back (default: 24)
   *   - limit (optional): Maximum number of queries to return (default: 50)
   */
  router.get('/api/query-performance/slow', controller.getSlowQueries.bind(controller));

  /**
   * @route GET /api/query-performance/hourly-stats
   * @desc Get hourly aggregated query statistics
   * @access Public
   * @params
   *   - days (optional): Number of days to look back (default: 1)
   */
  router.get('/api/query-performance/hourly-stats', controller.getHourlyStats.bind(controller));

  /**
   * @route GET /api/query-performance/health
   * @desc Get database health metrics and status
   * @access Public
   */
  router.get('/api/query-performance/health', controller.getDatabaseHealth.bind(controller));

  return router;
} 