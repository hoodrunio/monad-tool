/**
 * Enhanced Epoch Routes (Protocol-Accurate)
 * Version: v2
 */

import { Router } from 'express';
import { EnhancedEpochController } from '../controllers/EnhancedEpochController';

export function createEnhancedEpochRoutes(controller: EnhancedEpochController): Router {
  const router = Router();

  /**
   * @route GET /api/v2/epoch/info
   * @desc Get comprehensive protocol-accurate epoch information
   * @access Public
   * @returns Enhanced epoch info with:
   *   - Canonical epoch from precompile
   *   - Round-based progress (normal/delay/stale phase)
   *   - Delay period configuration and progress
   *   - Robust ABT with outlier stats
   *   - Staleness detection
   */
  router.get('/api/v2/epoch/info', controller.getEnhancedEpochInfo.bind(controller));

  /**
   * @route GET /api/v2/epoch/current
   * @desc Get current epoch ID and delay status (lightweight)
   * @access Public
   * @returns { epochId, inEpochDelayPeriod, phase, precompileAvailable, isStale }
   */
  router.get('/api/v2/epoch/current', controller.getCurrentEpoch.bind(controller));

  /**
   * @route GET /api/v2/epoch/progress
   * @desc Get epoch progress information with phase tracking
   * @access Public
   * @returns Progress with phase, rounds, and delay config
   */
  router.get('/api/v2/epoch/progress', controller.getProgress.bind(controller));

  /**
   * @route GET /api/v2/epoch/abt
   * @desc Get Average Block Time with outlier statistics
   * @access Public
   * @returns ABT result with method, sample size, outlier rate
   */
  router.get('/api/v2/epoch/abt', controller.getAbt.bind(controller));

  /**
   * @route GET /api/v2/epoch/staleness
   * @desc Get indexer staleness information
   * @access Public
   * @returns Staleness info with block lag and age
   */
  router.get('/api/v2/epoch/staleness', controller.getStaleness.bind(controller));

  /**
   * @route POST /api/v2/epoch/abt/recompute
   * @desc Force recomputation of ABT
   * @access Public
   * @returns Success message
   */
  router.post('/api/v2/epoch/abt/recompute', controller.recomputeAbt.bind(controller));

  /**
   * @route GET /api/v2/epoch/health
   * @desc Health check for epoch tracking system
   * @access Public
   * @returns Health status (precompile + indexer availability)
   */
  router.get('/api/v2/epoch/health', controller.getHealth.bind(controller));

  return router;
}
