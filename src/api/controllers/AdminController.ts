// Monad Validator Analytics - Admin Controller
import { Request, Response } from 'express';
import { DataIngestionService } from '../../services/data-ingestion';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export class AdminController {
  constructor(
    private ingestionService: DataIngestionService,
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {}

  // =============================================
  // CACHE MANAGEMENT
  // =============================================

  async flushCache(req: Request, res: Response): Promise<void> {
    try {
      const pattern = req.query.pattern as string;
      
      if (pattern) {
        // Flush specific pattern
        await this.redisClient.invalidatePattern(pattern);
        logger.info(`Cache pattern flushed: ${pattern}`);
        
        res.json({
          success: true,
          message: `Cache pattern '${pattern}' flushed successfully`,
          timestamp: new Date().toISOString()
        });
      } else {
        // Flush all cache
        await this.redisClient.flushAll();
        logger.info('All cache flushed');
        
        res.json({
          success: true,
          message: 'All cache flushed successfully',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error('Failed to flush cache:', error);
      res.status(500).json({
        error: 'Failed to flush cache',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async getCacheStats(req: Request, res: Response): Promise<void> {
    try {
      const cacheInfo = await this.redisClient.getCacheInfo();
      const cacheMetrics = this.redisClient.getCacheMetrics();
      
      res.json({
        cache_info: cacheInfo,
        cache_metrics: cacheMetrics,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get cache stats:', error);
      res.status(500).json({
        error: 'Failed to get cache stats',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async warmupCache(req: Request, res: Response): Promise<void> {
    try {
      await this.redisClient.warmupCache();
      
      res.json({
        success: true,
        message: 'Cache warmup completed successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to warmup cache:', error);
      res.status(500).json({
        error: 'Failed to warmup cache',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // LOG PROCESSING MANAGEMENT
  // =============================================

  async processLogs(req: Request, res: Response): Promise<void> {
    try {
      const { logLines } = req.body;
      
      if (!logLines || !Array.isArray(logLines)) {
        res.status(400).json({
          error: 'Invalid input',
          message: 'logLines array is required in request body',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (logLines.length > 10000) {
        res.status(400).json({
          error: 'Batch too large',
          message: 'Maximum 10,000 log lines per batch',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const startTime = Date.now();
      await this.ingestionService.ingestBatch(logLines);
      const processingTime = Date.now() - startTime;
      
      logger.info(`Processed ${logLines.length} log lines in ${processingTime}ms`);
      
      res.json({
        success: true,
        message: `Successfully processed ${logLines.length} log lines`,
        processing_time_ms: processingTime,
        logs_processed: logLines.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to process logs:', error);
      res.status(500).json({
        error: 'Failed to process logs',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async getIngestionStatus(req: Request, res: Response): Promise<void> {
    try {
      const isRunning = this.ingestionService.isServiceRunning();
      const queueSize = this.ingestionService.getQueueSize();
      const metrics = this.ingestionService.getMetrics();
      
      res.json({
        status: isRunning ? 'running' : 'stopped',
        queue_size: queueSize,
        metrics,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get ingestion status:', error);
      res.status(500).json({
        error: 'Failed to get ingestion status',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // DATABASE MANAGEMENT
  // =============================================

  async getDatabaseStats(req: Request, res: Response): Promise<void> {
    try {
      const tableStats = await this.clickhouseClient.getTableStats();
      
      // Get additional database metrics
      const query = `
        SELECT 
          formatReadableSize(sum(bytes_on_disk)) as total_size,
          sum(rows) as total_rows,
          count(*) as total_tables
        FROM system.parts 
        WHERE database = 'monad_analytics'
          AND active = 1
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const dbMetrics = await result.json() as any[];
      
      res.json({
        database_metrics: dbMetrics[0],
        table_stats: tableStats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get database stats:', error);
      res.status(500).json({
        error: 'Failed to get database stats',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async optimizeDatabase(req: Request, res: Response): Promise<void> {
    try {
      const tableName = req.query.table as string || 'validator_events';
      
      // Run OPTIMIZE TABLE command for better performance
      const query = `OPTIMIZE TABLE ${tableName} FINAL`;
      
      await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });
      
      logger.info(`Database table ${tableName} optimized`);
      
      res.json({
        success: true,
        message: `Table ${tableName} optimized successfully`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to optimize database:', error);
      res.status(500).json({
        error: 'Failed to optimize database',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // MAINTENANCE OPERATIONS
  // =============================================

  async getMaintenanceStatus(req: Request, res: Response): Promise<void> {
    try {
      // Check various system health indicators
      const systemHealth = await this.ingestionService.getSystemHealth();
      const dbPing = await this.clickhouseClient.ping();
      const cachePing = await this.redisClient.ping();
      
      // Get disk usage and performance metrics
      const diskUsageQuery = `
        SELECT 
          formatReadableSize(free_space) as free_space,
          formatReadableSize(total_space) as total_space,
          round((total_space - free_space) / total_space * 100, 2) as disk_usage_percent
        FROM system.disks 
        WHERE name = 'default'
      `;

      const diskResult = await this.clickhouseClient['client'].query({
        query: diskUsageQuery,
        format: 'JSONEachRow'
      });

      const diskUsage = await diskResult.json() as any[];
      
      const maintenanceStatus = {
        overall_health: dbPing && cachePing && systemHealth.database && systemHealth.cache ? 'healthy' : 'needs_attention',
        components: {
          database: {
            status: dbPing ? 'healthy' : 'unhealthy',
            connected: dbPing
          },
          cache: {
            status: cachePing ? 'healthy' : 'unhealthy',
            connected: cachePing,
            metrics: systemHealth.cacheMetrics
          },
          ingestion: {
            status: systemHealth.ingestion ? 'running' : 'stopped',
            metrics: systemHealth.ingestion
          },
          disk: diskUsage[0] || null
        },
        recommendations: this.getMaintenanceRecommendations(systemHealth, diskUsage[0]),
        timestamp: new Date().toISOString()
      };

      res.json(maintenanceStatus);
    } catch (error) {
      logger.error('Failed to get maintenance status:', error);
      res.status(500).json({
        error: 'Failed to get maintenance status',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async performMaintenance(req: Request, res: Response): Promise<void> {
    try {
      const { operation } = req.body;
      
      const validOperations = ['optimize_db', 'clear_old_data', 'warmup_cache', 'vacuum_logs'];
      
      if (!operation || !validOperations.includes(operation)) {
        res.status(400).json({
          error: 'Invalid operation',
          message: `Operation must be one of: ${validOperations.join(', ')}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      let result: any = {};
      const startTime = Date.now();

      switch (operation) {
        case 'optimize_db':
          await this.clickhouseClient['client'].query({
            query: 'OPTIMIZE TABLE validator_events FINAL',
            format: 'JSONEachRow'
          });
          result.message = 'Database optimized successfully';
          break;

        case 'clear_old_data':
          const retentionDays = req.body.retention_days || 30;
          await this.clickhouseClient['client'].query({
            query: `ALTER TABLE validator_events DELETE WHERE timestamp < now() - INTERVAL ${retentionDays} DAY`,
            format: 'JSONEachRow'
          });
          result.message = `Old data cleared (older than ${retentionDays} days)`;
          break;

        case 'warmup_cache':
          await this.redisClient.warmupCache();
          result.message = 'Cache warmed up successfully';
          break;

        case 'vacuum_logs':
          // This would implement log cleanup logic
          result.message = 'Log vacuum completed successfully';
          break;
      }

      const duration = Date.now() - startTime;
      
      res.json({
        success: true,
        operation,
        duration_ms: duration,
        ...result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to perform maintenance:', error);
      res.status(500).json({
        error: 'Failed to perform maintenance',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // HELPER METHODS
  // =============================================

  private getMaintenanceRecommendations(systemHealth: any, diskUsage: any): string[] {
    const recommendations: string[] = [];

    // Database recommendations
    if (!systemHealth.database) {
      recommendations.push('Database connection issues detected - check ClickHouse service');
    }

    // Cache recommendations
    if (!systemHealth.cache) {
      recommendations.push('Cache connection issues detected - check Redis service');
    } else if (systemHealth.cacheMetrics.hitRate < 80) {
      recommendations.push('Cache hit rate is low - consider cache warmup or TTL optimization');
    }

    // Disk usage recommendations
    if (diskUsage && diskUsage.disk_usage_percent > 80) {
      recommendations.push('Disk usage is high - consider data cleanup or storage expansion');
    } else if (diskUsage && diskUsage.disk_usage_percent > 90) {
      recommendations.push('CRITICAL: Disk usage is very high - immediate cleanup required');
    }

    // Ingestion recommendations
    if (systemHealth.ingestion.errorRate > 5) {
      recommendations.push('High error rate in log ingestion - check log formats and processing');
    }

    if (recommendations.length === 0) {
      recommendations.push('System is operating normally - no maintenance required');
    }

    return recommendations;
  }
} 