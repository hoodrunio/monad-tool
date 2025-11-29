// Monad Validator Analytics - Query Performance Controller
// Provides endpoints for monitoring ClickHouse query performance and database health

import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { logger } from '../../utils/logger';

export class QueryPerformanceController {
  constructor(
    private clickhouseClient: MonadClickHouseClient
  ) {}
  
  /**
   * Get recent query performance metrics
   * GET /api/query-performance/recent
   */
  async getRecentPerformance(req: Request, res: Response): Promise<void> {
    try {
      const { hours = 1, limit = 50 } = req.query;

      const query = `
        SELECT 
          query_id,
          query_duration_ms,
          read_rows,
          readable_bytes,
          readable_memory,
          query_snippet,
          event_time,
          type,
          user,
          exception
        FROM query_performance_monitor
        WHERE event_time >= now() - INTERVAL ${Number(hours)} HOUR
        ORDER BY query_duration_ms DESC
        LIMIT ${Number(limit)}
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      const data = result;

      res.json({
        success: true,
        data: {
          queries: data,
          metrics: {
            total_queries: data.length,
            time_window_hours: Number(hours),
            avg_duration_ms: data.length > 0 
              ? data.reduce((sum: number, q: any) => sum + q.query_duration_ms, 0) / data.length 
              : 0,
            max_duration_ms: data.length > 0 
              ? Math.max(...data.map((q: any) => q.query_duration_ms)) 
              : 0,
            failed_queries: data.filter((q: any) => q.exception && q.exception.length > 0).length
          }
        }
      });

    } catch (error) {
      logger.error('Error fetching query performance:', error);
      res.status(500).json({ 
        error: 'Failed to fetch query performance data',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get slow queries (> threshold)
   * GET /api/query-performance/slow
   */
  async getSlowQueries(req: Request, res: Response): Promise<void> {
    try {
      const { threshold = 1000, hours = 24, limit = 50 } = req.query;

      const query = `
        SELECT 
          query_id,
          query_duration_ms,
          memory_used,
          query_text,
          event_time,
          user,
          exception
        FROM slow_queries_monitor
        WHERE event_time >= now() - INTERVAL ${Number(hours)} HOUR
          AND query_duration_ms >= ${Number(threshold)}
        ORDER BY query_duration_ms DESC
        LIMIT ${Number(limit)}
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      const data = result;

      res.json({
        success: true,
        data: {
          slow_queries: data,
          threshold_ms: Number(threshold),
          time_window_hours: Number(hours),
          total_slow_queries: data.length
        }
      });

    } catch (error) {
      logger.error('Error fetching slow queries:', error);
      res.status(500).json({ 
        error: 'Failed to fetch slow queries',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get hourly query statistics
   * GET /api/query-performance/hourly-stats
   */
  async getHourlyStats(req: Request, res: Response): Promise<void> {
    try {
      const { days = 1 } = req.query;

      const query = `
        SELECT 
          hour,
          total_queries,
          avg_duration_ms,
          max_duration_ms,
          total_read_bytes,
          total_memory_usage,
          failed_queries
        FROM query_stats_hourly
        WHERE hour >= now() - INTERVAL ${Number(days)} DAY
        ORDER BY hour DESC
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      const data = result;

      res.json({
        success: true,
        data: {
          hourly_stats: data,
          time_window_days: Number(days),
          total_hours: data.length,
          summary: data.length > 0 ? {
            total_queries: data.reduce((sum: number, h: any) => sum + h.total_queries, 0),
            avg_queries_per_hour: data.reduce((sum: number, h: any) => sum + h.total_queries, 0) / data.length,
            overall_avg_duration: data.reduce((sum: number, h: any) => sum + h.avg_duration_ms, 0) / data.length,
            max_duration_observed: Math.max(...data.map((h: any) => h.max_duration_ms)),
            total_failed_queries: data.reduce((sum: number, h: any) => sum + h.failed_queries, 0)
          } : null
        }
      });

    } catch (error) {
      logger.error('Error fetching hourly stats:', error);
      res.status(500).json({ 
        error: 'Failed to fetch hourly statistics',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get database health metrics
   * GET /api/query-performance/health
   */
  async getDatabaseHealth(req: Request, res: Response): Promise<void> {
    try {
      // Check recent query performance
      const performanceQuery = `
        SELECT 
          count() as total_queries_last_hour,
          avg(query_duration_ms) as avg_duration_ms,
          max(query_duration_ms) as max_duration_ms,
          sum(read_bytes) as total_bytes_read,
          sum(memory_usage) as total_memory_used,
          countIf(exception != '') as failed_queries
        FROM system.query_log
        WHERE event_time >= now() - INTERVAL 1 HOUR
          AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
          AND (current_database = 'monad_analytics' OR has(databases, 'monad_analytics'))
      `;

      // Check system metrics
      const systemQuery = `
        SELECT 
          formatReadableSize(sum(bytes_on_disk)) as total_disk_usage,
          sum(rows) as total_rows,
          count() as total_tables
        FROM system.parts
        WHERE database = 'monad_analytics'
          AND active = 1
      `;

      const [performanceResult, systemResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(performanceQuery),
        this.clickhouseClient.executeRawQuery(systemQuery)
      ]);

      const [performance] = performanceResult;
      const [system] = systemResult;

      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        performance: {
          queries_last_hour: performance?.total_queries_last_hour || 0,
          avg_query_duration_ms: performance?.avg_duration_ms || 0,
          max_query_duration_ms: performance?.max_duration_ms || 0,
          total_bytes_read: performance?.total_bytes_read || 0,
          total_memory_used: performance?.total_memory_used || 0,
          failed_queries: performance?.failed_queries || 0,
          success_rate: performance?.total_queries_last_hour > 0 
            ? ((performance.total_queries_last_hour - performance.failed_queries) / performance.total_queries_last_hour * 100)
            : 100
        },
        storage: {
          disk_usage: system?.total_disk_usage || '0 B',
          total_rows: system?.total_rows || 0,
          total_tables: system?.total_tables || 0
        }
      };

      // Determine health status based on metrics
      if (performance?.failed_queries > performance?.total_queries_last_hour * 0.1) {
        health.status = 'warning'; // More than 10% failures
      }
      if (performance?.avg_duration_ms > 5000) {
        health.status = 'warning'; // Average query time > 5 seconds
      }
      if (performance?.failed_queries > performance?.total_queries_last_hour * 0.25) {
        health.status = 'critical'; // More than 25% failures
      }

      res.json({
        success: true,
        data: health
      });

    } catch (error) {
      logger.error('Error fetching database health:', error);
      res.status(500).json({ 
        error: 'Failed to fetch database health',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
} 