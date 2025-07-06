// Monad Validator Analytics - Epoch Controller
import { Request, Response } from 'express';
import { EpochService, EpochProgress, EpochInfo } from '../../services/epoch/EpochService';
import { NodeRpcClient } from '../../services/blockchain/NodeRpcClient';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export class EpochController {
  private epochService: EpochService;

  constructor(private redisClient: MonadRedisClient) {
    // Initialize RPC client with environment configuration
    const rpcUrl = process.env.RPC_URL || 'http://localhost:8080';
    const rpcTimeout = parseInt(process.env.RPC_TIMEOUT || '10000');
    const rpcClient = new NodeRpcClient(rpcUrl, rpcTimeout);
    
    // Initialize Epoch service with 50k block interval for Monad
    this.epochService = new EpochService(rpcClient, 50000);
    
    // Set average block time if configured
    const avgBlockTime = parseFloat(process.env.AVG_BLOCK_TIME || '2');
    this.epochService.setAverageBlockTime(avgBlockTime);
  }

  // =============================================
  // EPOCH PROGRESS ENDPOINTS
  // =============================================

  /**
   * Get current epoch progress
   * GET /api/epoch/progress
   */
  async getEpochProgress(req: Request, res: Response): Promise<void> {
    try {
      // Try cache first
      const cacheKey = 'epoch_progress';
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        const cachedData = JSON.parse(cached);
        res.json({
          success: true,
          data: cachedData,
          metadata: {
            source: 'cache',
            cachedAt: new Date(cachedData.timestamp)
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Fetch fresh data
      const progress = await this.epochService.getEpochProgress();
      
      const responseData = {
        ...progress,
        timestamp: new Date().toISOString()
      };

      // Cache for 30 seconds (epochs change slowly)
      await this.redisClient['client'].setex(cacheKey, 30, JSON.stringify(responseData));
      
      res.json({
        success: true,
        data: responseData,
        metadata: {
          source: 'rpc',
          epochInterval: this.epochService.getEpochInterval()
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get epoch progress:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get epoch progress',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get comprehensive epoch information
   * GET /api/epoch/info
   */
  async getEpochInfo(req: Request, res: Response): Promise<void> {
    try {
      // Try cache first
      const cacheKey = 'epoch_info';
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        const cachedData = JSON.parse(cached);
        res.json({
          success: true,
          data: cachedData,
          metadata: {
            source: 'cache',
            cachedAt: new Date(cachedData.timestamp)
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Fetch fresh data
      const epochInfo = await this.epochService.getEpochInfo();
      
      const responseData = {
        ...epochInfo,
        timestamp: new Date().toISOString()
      };

      // Cache for 30 seconds
      await this.redisClient['client'].setex(cacheKey, 30, JSON.stringify(responseData));
      
      res.json({
        success: true,
        data: responseData,
        metadata: {
          source: 'rpc',
          epochInterval: this.epochService.getEpochInterval()
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get epoch info:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get epoch info',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get current epoch number only
   * GET /api/epoch/current
   */
  async getCurrentEpoch(req: Request, res: Response): Promise<void> {
    try {
      // Try cache first
      const cacheKey = 'current_epoch';
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        const cachedData = JSON.parse(cached);
        res.json({
          success: true,
          data: {
            currentEpoch: cachedData.currentEpoch,
            timestamp: cachedData.timestamp
          },
          metadata: {
            source: 'cache',
            cachedAt: new Date(cachedData.timestamp)
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Fetch fresh data
      const currentEpoch = await this.epochService.getCurrentEpoch();
      
      const responseData = {
        currentEpoch,
        timestamp: new Date().toISOString()
      };

      // Cache for 60 seconds (epoch changes less frequently)
      await this.redisClient['client'].setex(cacheKey, 10, JSON.stringify(responseData));
      
      res.json({
        success: true,
        data: responseData,
        metadata: {
          source: 'rpc',
          epochInterval: this.epochService.getEpochInterval()
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get current epoch:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get current epoch',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get epoch information for a specific block
   * GET /api/epoch/block/:blockNumber
   */
  async getEpochForBlock(req: Request, res: Response): Promise<void> {
    try {
      const blockNumber = parseInt(req.params.blockNumber);
      
      if (isNaN(blockNumber) || blockNumber < 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid block number',
          message: 'Block number must be a non-negative integer',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const epoch = this.epochService.getEpochForBlock(blockNumber);
      const blockRange = this.epochService.getEpochBlockRange(epoch);
      
      res.json({
        success: true,
        data: {
          blockNumber,
          epoch,
          epochStartBlock: blockRange.startBlock,
          epochEndBlock: blockRange.endBlock,
          blockPositionInEpoch: blockNumber - blockRange.startBlock,
          epochInterval: this.epochService.getEpochInterval()
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get epoch for block:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get epoch for block',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get block range for a specific epoch
   * GET /api/epoch/:epochNumber/blocks
   */
  async getEpochBlockRange(req: Request, res: Response): Promise<void> {
    try {
      const epochNumber = parseInt(req.params.epochNumber);
      
      if (isNaN(epochNumber) || epochNumber < 1) {
        res.status(400).json({
          success: false,
          error: 'Invalid epoch number',
          message: 'Epoch number must be a positive integer',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const blockRange = this.epochService.getEpochBlockRange(epochNumber);
      
      res.json({
        success: true,
        data: {
          epoch: epochNumber,
          startBlock: blockRange.startBlock,
          endBlock: blockRange.endBlock,
          totalBlocks: this.epochService.getEpochInterval(),
          epochInterval: this.epochService.getEpochInterval()
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get epoch block range:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get epoch block range',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Update average block time configuration
   * POST /api/epoch/config/block-time
   * Body: { averageBlockTimeSeconds: number }
   */
  async updateBlockTime(req: Request, res: Response): Promise<void> {
    try {
      const { averageBlockTimeSeconds } = req.body;
      
      if (!averageBlockTimeSeconds || typeof averageBlockTimeSeconds !== 'number' || averageBlockTimeSeconds <= 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid block time',
          message: 'averageBlockTimeSeconds must be a positive number',
          timestamp: new Date().toISOString()
        });
        return;
      }

      this.epochService.setAverageBlockTime(averageBlockTimeSeconds);
      
      // Clear cache to force refresh with new timing
      await Promise.all([
        this.redisClient['client'].del('epoch_progress'),
        this.redisClient['client'].del('epoch_info')
      ]);
      
      res.json({
        success: true,
        data: {
          averageBlockTimeSeconds,
          message: 'Average block time updated successfully'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to update block time:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update block time',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get epoch configuration
   * GET /api/epoch/config
   */
  async getEpochConfig(req: Request, res: Response): Promise<void> {
    try {
      res.json({
        success: true,
        data: {
          epochInterval: this.epochService.getEpochInterval(),
          blocksPerEpoch: 50000,
          description: 'Monad blockchain epoch configuration'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get epoch config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get epoch config',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }
} 