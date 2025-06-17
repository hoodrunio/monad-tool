// Monad Validator Analytics - Health & System Controller
import { Request, Response } from 'express';
import { DataIngestionService } from '../../services/data-ingestion';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export class HealthController {
  constructor(
    private ingestionService: DataIngestionService,
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {}

  // =============================================
  // BASIC HEALTH CHECK
  // =============================================

  async getHealth(req: Request, res: Response): Promise<void> {
    try {
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '1.0.0',
        service: 'Monad Validator Analytics API'
      });
    } catch (error) {
      logger.error('Health check failed:', error);
      res.status(500).json({
        status: 'unhealthy',
        error: 'Health check failed',
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // DETAILED SYSTEM HEALTH
  // =============================================

  async getSystemHealth(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.ingestionService.getSystemHealth();
      
      const overallHealth = health.database && health.cache ? 'healthy' : 'unhealthy';
      const statusCode = overallHealth === 'healthy' ? 200 : 503;
      
      res.status(statusCode).json({
        status: overallHealth,
        components: {
          database: health.database ? 'healthy' : 'unhealthy',
          cache: health.cache ? 'healthy' : 'unhealthy',
          ingestion: {
            running: this.ingestionService.isServiceRunning(),
            queueSize: this.ingestionService.getQueueSize(),
            metrics: health.ingestion
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('System health check failed:', error);
      res.status(500).json({
        error: 'System health check failed',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // SYSTEM METRICS
  // =============================================

  async getSystemMetrics(req: Request, res: Response): Promise<void> {
    try {
      const metrics = this.ingestionService.getMetrics();
      const cacheMetrics = this.redisClient.getCacheMetrics();
      
      res.json({
        ingestion: metrics,
        cache: cacheMetrics,
        system: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          cpuUsage: process.cpuUsage(),
          nodeVersion: process.version,
          platform: process.platform
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get system metrics:', error);
      res.status(500).json({
        error: 'Failed to get system metrics',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // CACHE INFORMATION
  // =============================================

  async getCacheInfo(req: Request, res: Response): Promise<void> {
    try {
      const cacheInfo = await this.redisClient.getCacheInfo();
      res.json({
        cache: cacheInfo,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get cache info:', error);
      res.status(500).json({
        error: 'Failed to get cache info',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // DATABASE TABLE STATISTICS
  // =============================================

  async getTableStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.clickhouseClient.getTableStats();
      res.json({
        tables: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get table stats:', error);
      res.status(500).json({
        error: 'Failed to get table stats',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // READINESS PROBE
  // =============================================

  async getReadiness(req: Request, res: Response): Promise<void> {
    try {
      // Check if all critical services are ready
      const dbPing = await this.clickhouseClient.ping();
      const cachePing = await this.redisClient.ping();
      const ingestionRunning = this.ingestionService.isServiceRunning();

      const isReady = dbPing && cachePing && ingestionRunning;

      res.status(isReady ? 200 : 503).json({
        ready: isReady,
        checks: {
          database: dbPing,
          cache: cachePing,
          ingestion: ingestionRunning
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Readiness check failed:', error);
      res.status(503).json({
        ready: false,
        error: 'Readiness check failed',
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // LIVENESS PROBE  
  // =============================================

  async getLiveness(req: Request, res: Response): Promise<void> {
    try {
      // Simple liveness check - just verify the process is responding
      res.status(200).json({
        alive: true,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        pid: process.pid
      });
    } catch (error) {
      logger.error('Liveness check failed:', error);
      res.status(500).json({
        alive: false,
        error: 'Liveness check failed',
        timestamp: new Date().toISOString()
      });
    }
  }
} 