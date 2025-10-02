/**
 * Enhanced Epoch Controller (Protocol-Accurate)
 * 
 * Provides API endpoints for protocol-accurate epoch tracking with:
 * - Canonical epoch from staking precompile
 * - Round-based progress tracking
 * - Delay period support
 * - Robust ABT with outlier handling
 * - Staleness detection
 */

import { Request, Response } from 'express';
import { MonadRedisClient } from '../../cache/redis-client';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { NodeRpcClient } from '../../services/blockchain/NodeRpcClient';
import { EnhancedEpochService } from '../../services/epoch/EnhancedEpochService';
import { logger } from '../../utils/logger';

export class EnhancedEpochController {
  private epochService: EnhancedEpochService;

  constructor(
    private redisClient: MonadRedisClient,
    clickhouse: MonadClickHouseClient,
    rpcClient: NodeRpcClient,
    epochInterval: number = 5000
  ) {
    this.epochService = new EnhancedEpochService(clickhouse.getClient(), rpcClient, epochInterval);
    
    logger.info('EnhancedEpochController initialized', {
      epochInterval,
    });
  }

  /**
   * Get comprehensive enhanced epoch information
   * GET /api/v2/epoch/info
   */
  async getEnhancedEpochInfo(req: Request, res: Response): Promise<void> {
    try {
      const cacheKey = 'enhanced_epoch_info';
      const cacheTtl = 15; // 15 seconds cache for epoch info
      
      // Try cache first
      const cached = await this.redisClient['client'].get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        res.json({
          success: true,
          data: cachedData,
          metadata: {
            source: 'cache',
            version: 'v2-protocol-accurate',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Fetch fresh data
      const epochInfo = await this.epochService.getEpochInfo();
      
      // Format response
      const responseData = {
        epochId: epochInfo.epochId,
        inEpochDelayPeriod: epochInfo.inEpochDelayPeriod,
        
        progress: {
          phase: epochInfo.progress.phase,
          value: epochInfo.progress.value,
          percentage: epochInfo.progress.percentage,
          explanation: epochInfo.progress.explanation,
          currentRound: epochInfo.progress.currentRound,
          epochStartRound: epochInfo.progress.epochStartRound,
          epochBoundaryRound: epochInfo.progress.epochBoundaryRound,
          roundsCompleted: epochInfo.progress.roundsCompleted,
          roundsToNextEpoch: epochInfo.progress.roundsToNextEpoch,
        },
        
        delayConfig: {
          configuredDelayRounds: epochInfo.delayConfig.configuredDelayRounds,
          elapsedDelayRounds: epochInfo.delayConfig.elapsedDelayRounds,
          remainingDelayRounds: epochInfo.delayConfig.remainingDelayRounds,
          delayProgressPercentage: epochInfo.delayConfig.delayProgressPercentage,
        },
        
        abt: epochInfo.abt ? {
          averageBlockTimeSeconds: epochInfo.abt.averageBlockTimeSeconds,
          medianBlockTimeSeconds: epochInfo.abt.medianBlockTimeSeconds,
          sampleSize: epochInfo.abt.sampleSize,
          effectiveSampleSize: epochInfo.abt.effectiveSampleSize,
          outlierCount: epochInfo.abt.outlierCount,
          outlierRate: epochInfo.abt.outlierRate,
          method: epochInfo.abt.method,
          computedAt: epochInfo.abt.computedAt,
        } : null,
        
        staleness: {
          isStale: epochInfo.staleness.isStale,
          latestIndexedBlock: epochInfo.staleness.latestIndexedBlock,
          latestIndexedTimestamp: epochInfo.staleness.latestIndexedTimestamp,
          ageSeconds: epochInfo.staleness.ageSeconds,
          chainHeadBlock: epochInfo.staleness.chainHeadBlock,
          blockLag: epochInfo.staleness.blockLag,
          reason: epochInfo.staleness.reason,
        },
        
        precompileAvailable: epochInfo.precompileAvailable,
        timestamp: epochInfo.timestamp,
      };

      // Cache the result
      await this.redisClient['client'].setex(cacheKey, cacheTtl, JSON.stringify(responseData));
      
      res.json({
        success: true,
        data: responseData,
        metadata: {
          source: 'computed',
          version: 'v2-protocol-accurate',
          epochInterval: this.epochService.getEpochInterval(),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get enhanced epoch info:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get enhanced epoch info',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get current epoch ID and delay status only (lightweight)
   * GET /api/v2/epoch/current
   */
  async getCurrentEpoch(req: Request, res: Response): Promise<void> {
    try {
      const cacheKey = 'enhanced_current_epoch';
      const cacheTtl = 10;
      
      const cached = await this.redisClient['client'].get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        res.json({
          success: true,
          data: cachedData,
          metadata: { source: 'cache', version: 'v2-protocol-accurate' },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const epochInfo = await this.epochService.getEpochInfo();
      
      const responseData = {
        epochId: epochInfo.epochId,
        inEpochDelayPeriod: epochInfo.inEpochDelayPeriod,
        phase: epochInfo.progress.phase,
        precompileAvailable: epochInfo.precompileAvailable,
        isStale: epochInfo.staleness.isStale,
        timestamp: epochInfo.timestamp,
      };

      await this.redisClient['client'].setex(cacheKey, cacheTtl, JSON.stringify(responseData));
      
      res.json({
        success: true,
        data: responseData,
        metadata: { source: 'computed', version: 'v2-protocol-accurate' },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get current epoch:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get current epoch',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get progress information only
   * GET /api/v2/epoch/progress
   */
  async getProgress(req: Request, res: Response): Promise<void> {
    try {
      const cacheKey = 'enhanced_epoch_progress';
      const cacheTtl = 15;
      
      const cached = await this.redisClient['client'].get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        res.json({
          success: true,
          data: cachedData,
          metadata: { source: 'cache', version: 'v2-protocol-accurate' },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const epochInfo = await this.epochService.getEpochInfo();
      
      const responseData = {
        epochId: epochInfo.epochId,
        progress: epochInfo.progress,
        delayConfig: epochInfo.delayConfig,
        isStale: epochInfo.staleness.isStale,
        timestamp: epochInfo.timestamp,
      };

      await this.redisClient['client'].setex(cacheKey, cacheTtl, JSON.stringify(responseData));
      
      res.json({
        success: true,
        data: responseData,
        metadata: { source: 'computed', version: 'v2-protocol-accurate' },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get epoch progress:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get epoch progress',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get ABT (Average Block Time) information
   * GET /api/v2/epoch/abt
   */
  async getAbt(req: Request, res: Response): Promise<void> {
    try {
      const cacheKey = 'enhanced_epoch_abt';
      const cacheTtl = 60; // ABT changes slowly
      
      const cached = await this.redisClient['client'].get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        res.json({
          success: true,
          data: cachedData,
          metadata: { source: 'cache', version: 'v2-protocol-accurate' },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const epochInfo = await this.epochService.getEpochInfo();
      
      if (!epochInfo.abt) {
        res.status(503).json({
          success: false,
          error: 'ABT computation unavailable',
          message: 'Average block time could not be computed',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      await this.redisClient['client'].setex(cacheKey, cacheTtl, JSON.stringify(epochInfo.abt));
      
      res.json({
        success: true,
        data: epochInfo.abt,
        metadata: { source: 'computed', version: 'v2-protocol-accurate' },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get ABT:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get ABT',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get staleness information
   * GET /api/v2/epoch/staleness
   */
  async getStaleness(req: Request, res: Response): Promise<void> {
    try {
      const epochInfo = await this.epochService.getEpochInfo();
      
      res.json({
        success: true,
        data: epochInfo.staleness,
        metadata: { version: 'v2-protocol-accurate' },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get staleness info:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get staleness info',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Force recompute ABT
   * POST /api/v2/epoch/abt/recompute
   */
  async recomputeAbt(req: Request, res: Response): Promise<void> {
    try {
      await this.epochService.recomputeAbt();
      
      // Clear cache
      await this.redisClient['client'].del('enhanced_epoch_abt');
      await this.redisClient['client'].del('enhanced_epoch_info');
      
      res.json({
        success: true,
        message: 'ABT recomputed successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to recompute ABT:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to recompute ABT',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Health check for epoch tracking system
   * GET /api/v2/epoch/health
   */
  async getHealth(req: Request, res: Response): Promise<void> {
    try {
      const isHealthy = await this.epochService.isHealthy();
      
      res.json({
        success: true,
        data: {
          healthy: isHealthy,
          message: isHealthy ? 'All systems operational' : 'Some systems degraded',
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to check epoch system health:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to check health',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }
}
