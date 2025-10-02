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
import { EpochService } from '../../services/epoch/EpochService';
import { logger } from '../../utils/logger';

export class EnhancedEpochController {
  private epochService: EnhancedEpochService;
  private fallbackEpochService: EpochService;
  private useFallback: boolean = false;

  constructor(
    private redisClient: MonadRedisClient,
    clickhouse: MonadClickHouseClient,
    rpcClient: NodeRpcClient,
    epochInterval: number = 5000
  ) {
    this.epochService = new EnhancedEpochService(clickhouse.getClient(), rpcClient, epochInterval);
    
    // Fallback: Basit block-based epoch hesaplama (0.5s ABT ile)
    this.fallbackEpochService = new EpochService(rpcClient, epochInterval);
    this.fallbackEpochService.setAverageBlockTime(0.5); // Monad default
    
    logger.info('EnhancedEpochController initialized with fallback', {
      epochInterval,
      fallbackEnabled: true,
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

      // Try enhanced service first
      let epochInfo;
      let usingFallback = false;
      
      try {
        epochInfo = await this.epochService.getEpochInfo();
        
        // Sadece gerçekten stale ise fallback'e geç
        // precompile yoksa da enhanced service DB'den epoch bulur, sorun değil
        if (epochInfo.staleness.isStale) {
          logger.warn('Enhanced service degraded (stale), using fallback', {
            isStale: epochInfo.staleness.isStale,
            reason: epochInfo.staleness.reason,
          });
          throw new Error('Enhanced service degraded - stale data');
        }
      } catch (enhancedError) {
        // Fallback: Basit block-based hesaplama
        logger.warn('Enhanced epoch service failed, using simple fallback', {
          error: enhancedError instanceof Error ? enhancedError.message : String(enhancedError),
        });
        
        usingFallback = true;
        const fallbackInfo = await this.fallbackEpochService.getEpochInfo();
        
        // Convert to enhanced format
        epochInfo = {
          epochId: fallbackInfo.currentEpoch,
          inEpochDelayPeriod: false,
          progress: {
            phase: 'normal' as const,
            value: fallbackInfo.progress.progressPercentage / 100,
            percentage: fallbackInfo.progress.progressPercentage,
            explanation: `Fallback mode: ${fallbackInfo.progress.blocksCompleted} of ${this.fallbackEpochService.getEpochInterval()} blocks completed`,
            currentRound: null,
            epochStartRound: null,
            epochBoundaryRound: null,
            roundsCompleted: fallbackInfo.progress.blocksCompleted,
            roundsToNextEpoch: fallbackInfo.progress.blocksRemaining,
          },
          delayConfig: {
            configuredDelayRounds: 500,
            elapsedDelayRounds: null,
            remainingDelayRounds: null,
            delayProgressPercentage: null,
          },
          abt: {
            averageBlockTimeSeconds: 0.5,
            medianBlockTimeSeconds: 0.5,
            sampleSize: 0,
            effectiveSampleSize: 0,
            outlierCount: 0,
            outlierRate: 0,
            method: 'hardcap' as const,
            computedAt: new Date(),
          },
          staleness: {
            isStale: false,
            latestIndexedBlock: fallbackInfo.currentBlock,
            latestIndexedTimestamp: new Date(),
            ageSeconds: 0,
            chainHeadBlock: fallbackInfo.currentBlock,
            blockLag: 0,
            reason: null,
          },
          precompileAvailable: false,
          timestamp: new Date(),
        };
      }
      
      // Format response - v1 compatible format
      const epochInterval = this.epochService.getEpochInterval();
      const currentBlock = epochInfo.staleness.latestIndexedBlock;
      const epochStartBlock = (epochInfo.epochId - 1) * epochInterval;
      const epochEndBlock = epochInfo.epochId * epochInterval - 1;
      
      // Calculate blocks correctly
      const blocksCompleted = currentBlock - epochStartBlock;
      const blocksRemaining = epochEndBlock - currentBlock;
      
      const responseData = {
        currentEpoch: epochInfo.epochId,
        previousEpoch: epochInfo.epochId - 1,
        nextEpoch: epochInfo.epochId + 1,
        epochInterval: epochInterval,
        currentBlock: currentBlock,
        
        progress: {
          currentEpoch: epochInfo.epochId,
          currentBlock: currentBlock,
          epochStartBlock: epochStartBlock,
          epochEndBlock: epochEndBlock,
          blocksCompleted: blocksCompleted,
          blocksRemaining: blocksRemaining,
          progressPercentage: epochInfo.progress.percentage || 0,
          estimatedTimeToNextEpoch: epochInfo.abt ? {
            hours: Math.floor(blocksRemaining * epochInfo.abt.averageBlockTimeSeconds / 3600),
            minutes: Math.floor((blocksRemaining * epochInfo.abt.averageBlockTimeSeconds % 3600) / 60),
            seconds: Math.floor(blocksRemaining * epochInfo.abt.averageBlockTimeSeconds % 60)
          } : undefined
        },
        
        // NEW: Delay period info
        inEpochDelayPeriod: epochInfo.inEpochDelayPeriod,
        delayPeriod: epochInfo.inEpochDelayPeriod ? {
          currentRound: epochInfo.progress.currentRound,
          roundsElapsed: epochInfo.delayConfig.elapsedDelayRounds,
          roundsRemaining: epochInfo.delayConfig.remainingDelayRounds,
          progressPercentage: epochInfo.delayConfig.delayProgressPercentage,
          totalDelayRounds: epochInfo.delayConfig.configuredDelayRounds
        } : null,
        
        timestamp: new Date().toISOString()
      };

      // Cache the result
      await this.redisClient['client'].setex(cacheKey, cacheTtl, JSON.stringify(responseData));
      
      res.json({
        success: true,
        data: responseData,
        metadata: {
          source: 'computed',
          version: usingFallback ? 'v2-fallback-simple' : 'v2-protocol-accurate',
          mode: usingFallback ? 'fallback' : 'enhanced',
          epochInterval: this.epochService.getEpochInterval(),
          warning: usingFallback ? 'Using simple block-based calculation (0.5s ABT) due to enhanced service unavailability' : undefined,
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

      let epochInfo;
      let usingFallback = false;
      
      try {
        epochInfo = await this.epochService.getEpochInfo();
        // Sadece stale ise fallback
        if (epochInfo.staleness.isStale) {
          throw new Error('Enhanced service degraded - stale data');
        }
      } catch (enhancedError) {
        usingFallback = true;
        const fallbackInfo = await this.fallbackEpochService.getEpochInfo();
        epochInfo = {
          epochId: fallbackInfo.currentEpoch,
          inEpochDelayPeriod: false,
          progress: { phase: 'normal' as const },
          precompileAvailable: false,
          staleness: { isStale: false },
          timestamp: new Date(),
        } as any;
      }
      
      const responseData = {
        epochId: epochInfo.epochId,
        inEpochDelayPeriod: epochInfo.inEpochDelayPeriod,
        phase: epochInfo.progress.phase,
        precompileAvailable: epochInfo.precompileAvailable,
        isStale: epochInfo.staleness.isStale,
        timestamp: epochInfo.timestamp,
        mode: usingFallback ? 'fallback' : 'enhanced',
      };

      await this.redisClient['client'].setex(cacheKey, cacheTtl, JSON.stringify(responseData));
      
      res.json({
        success: true,
        data: responseData,
        metadata: { 
          source: 'computed', 
          version: usingFallback ? 'v2-fallback-simple' : 'v2-protocol-accurate',
          mode: usingFallback ? 'fallback' : 'enhanced',
        },
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
