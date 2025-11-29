// Monad Validator Analytics - Epoch Routes
import { Router } from 'express';
import { EpochController } from '../controllers/EpochController';

export function createEpochRoutes(epochController: EpochController): Router {
  const router = Router();

  // =============================================
  // EPOCH PROGRESS ENDPOINTS
  // =============================================

  /**
   * @route GET /api/epoch/progress
   * @desc Get current epoch progress with completion percentage and time estimates
   * @access Public
   * @returns {
   *   success: boolean,
   *   data: {
   *     currentEpoch: number,
   *     currentBlock: number,
   *     epochStartBlock: number,
   *     epochEndBlock: number,
   *     blocksCompleted: number,
   *     blocksRemaining: number,
   *     progressPercentage: number,
   *     estimatedTimeToNextEpoch: {
   *       hours: number,
   *       minutes: number,
   *       seconds: number
   *     },
   *     timestamp: string
   *   }
   * }
   */
  router.get('/api/epoch/progress', epochController.getEpochProgress.bind(epochController));

  /**
   * @route GET /api/epoch/info
   * @desc Get comprehensive epoch information including progress
   * @access Public
   * @returns {
   *   success: boolean,
   *   data: {
   *     currentEpoch: number,
   *     previousEpoch: number,
   *     nextEpoch: number,
   *     epochInterval: number,
   *     currentBlock: number,
   *     progress: EpochProgress,
   *     timestamp: string
   *   }
   * }
   */
  router.get('/api/epoch/info', epochController.getEpochInfo.bind(epochController));

  /**
   * @route GET /api/epoch/current
   * @desc Get current epoch number only (lightweight endpoint)
   * @access Public
   * @returns {
   *   success: boolean,
   *   data: {
   *     currentEpoch: number,
   *     timestamp: string
   *   }
   * }
   */
  router.get('/api/epoch/current', epochController.getCurrentEpoch.bind(epochController));

  // =============================================
  // EPOCH CALCULATION ENDPOINTS
  // =============================================

  /**
   * @route GET /api/epoch/block/:blockNumber
   * @desc Get epoch information for a specific block number
   * @access Public
   * @param blockNumber - The block number to query
   * @returns {
   *   success: boolean,
   *   data: {
   *     blockNumber: number,
   *     epoch: number,
   *     epochStartBlock: number,
   *     epochEndBlock: number,
   *     blockPositionInEpoch: number,
   *     epochInterval: number
   *   }
   * }
   */
  router.get('/api/epoch/block/:blockNumber', epochController.getEpochForBlock.bind(epochController));

  /**
   * @route GET /api/epoch/:epochNumber/blocks
   * @desc Get block range for a specific epoch
   * @access Public
   * @param epochNumber - The epoch number to query
   * @returns {
   *   success: boolean,
   *   data: {
   *     epoch: number,
   *     startBlock: number,
   *     endBlock: number,
   *     totalBlocks: number,
   *     epochInterval: number
   *   }
   * }
   */
  router.get('/api/epoch/:epochNumber/blocks', epochController.getEpochBlockRange.bind(epochController));

  // =============================================
  // EPOCH CONFIGURATION ENDPOINTS
  // =============================================

  /**
   * @route GET /api/epoch/config
   * @desc Get epoch configuration information
   * @access Public
   * @returns {
   *   success: boolean,
   *   data: {
   *     epochInterval: number,
   *     blocksPerEpoch: number,
   *     description: string
   *   }
   * }
   */
  router.get('/api/epoch/config', epochController.getEpochConfig.bind(epochController));

  /**
   * @route POST /api/epoch/config/block-time
   * @desc Update average block time for more accurate time estimates
   * @access Public
   * @body { averageBlockTimeSeconds: number }
   * @returns {
   *   success: boolean,
   *   data: {
   *     averageBlockTimeSeconds: number,
   *     message: string
   *   }
   * }
   */
  router.post('/api/epoch/config/block-time', epochController.updateBlockTime.bind(epochController));

  return router;
} 