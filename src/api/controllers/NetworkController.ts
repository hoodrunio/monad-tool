// Monad Validator Analytics - Network Controller
import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export class NetworkController {
  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {}

  // =============================================
  // NETWORK SUMMARY
  // =============================================

  async getNetworkSummary(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      
      // Try cache first
      const cacheKey = `network_summary:${timeWindow}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          summary: JSON.parse(cached),
          metadata: {
            timeWindow,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Get interval for query
      let intervalClause = '24 HOUR';
      switch (timeWindow) {
        case '1h':
          intervalClause = '1 HOUR';
          break;
        case '24h':
          intervalClause = '24 HOUR';
          break;
        case '7d':
          intervalClause = '7 DAY';
          break;
      }

      // Get summary stats from database
      const query = `
        SELECT 
          COUNT(*) as total_events,
          COUNT(DISTINCT validator_id) as unique_validators,
          COUNT(DISTINCT event_type) as event_types,
          COUNT(DISTINCT toDate(timestamp)) as active_days,
          AVG(processing_delay_ms) as avg_processing_delay,
          MAX(timestamp) as latest_event,
          MIN(timestamp) as earliest_event,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) as successful_events,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) / COUNT(*) * 100 as overall_success_rate
        FROM validator_events
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const summary = await result.json() as any[];
      
      // Cache result for 2 minutes
      await this.redisClient['client'].setex(cacheKey, 120, JSON.stringify(summary[0]));
      
      res.json({
        summary: summary[0] || {},
        metadata: {
          timeWindow,
          source: 'database'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get network summary:', error);
      res.status(500).json({
        error: 'Failed to get network summary',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // NETWORK METRICS
  // =============================================

  async getNetworkMetrics(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '1h';
      const granularity = (req.query.granularity as string) || '1m';
      
      // Validate timeWindow
      const validTimeWindows = ['1m', '1h', '24h'] as const;
      const validatedTimeWindow = validTimeWindows.includes(timeWindow as any) ? 
        timeWindow as '1m' | '1h' | '24h' : '1h';

      // Try cache first
      const cacheKey = `network_metrics:${timeWindow}:${granularity}`;
      const cached = await this.redisClient.getNetworkMetrics(validatedTimeWindow);
      
      if (cached) {
        res.json({
          metrics: cached,
          metadata: {
            timeWindow,
            granularity,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Query database for time-series metrics
      const metrics = await this.clickhouseClient.getNetworkMetrics(validatedTimeWindow);
      
      // Cache result for 1 minute
      await this.redisClient.cacheNetworkMetrics(validatedTimeWindow, metrics, 60);
      
      res.json({
        metrics,
        metadata: {
          timeWindow,
          granularity,
          source: 'database',
          dataPoints: Array.isArray(metrics) ? metrics.length : 0
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get network metrics:', error);
      res.status(500).json({
        error: 'Failed to get network metrics',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // GEOGRAPHIC DISTRIBUTION
  // =============================================

  async getGeographicDistribution(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      
      // Try cache first
      const cached = await this.redisClient.getGeographicDistribution();
      
      if (cached) {
        res.json({
          distribution: cached,
          metadata: {
            timeWindow,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Query database for geographic distribution
      const distribution = await this.clickhouseClient.getGeographicDistribution();
      
      // Cache result for 5 minutes
      await this.redisClient.cacheGeographicDistribution(distribution, 300);
      
      res.json({
        distribution,
        metadata: {
          timeWindow,
          source: 'database',
          regions: Array.isArray(distribution) ? distribution.length : 0
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get geographic distribution:', error);
      res.status(500).json({
        error: 'Failed to get geographic distribution',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // NETWORK HEALTH SCORE
  // =============================================

  async getNetworkHealthScore(req: Request, res: Response): Promise<void> {
    try {
      const query = `
        SELECT 
          COUNT(DISTINCT validator_id) as active_validators,
          AVG(processing_delay_ms) as avg_processing_delay,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) / COUNT(*) * 100 as success_rate,
          COUNT(DISTINCT geographic_region) as geographic_diversity,
          COUNT(DISTINCT infrastructure_provider) as provider_diversity,
          stddevPop(processing_delay_ms) as delay_variance
        FROM validator_events
        WHERE timestamp >= now() - INTERVAL 1 HOUR
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const metrics = await result.json() as any[];
      const data = metrics[0];

      // Calculate health score (0-100)
      const healthScore = this.calculateHealthScore(data);
      
      res.json({
        healthScore,
        metrics: data,
        breakdown: {
          validator_activity: Math.min(100, (data.active_validators / 50) * 100), // Assume 50 target validators
          performance: Math.max(0, 100 - (data.avg_processing_delay / 100)), // Lower delay = higher score
          reliability: data.success_rate,
          geographic_diversity: Math.min(100, (data.geographic_diversity / 5) * 100), // 5 regions max
          provider_diversity: Math.min(100, (data.provider_diversity / 10) * 100) // 10 providers max
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get network health score:', error);
      res.status(500).json({
        error: 'Failed to get network health score',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // CONSENSUS EFFICIENCY
  // =============================================

  async getConsensusEfficiency(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '1h';
      
      const query = `
        SELECT 
          toStartOfMinute(timestamp) as minute,
          COUNT(*) as total_consensus_events,
          COUNT(CASE WHEN event_type LIKE '%vote%' THEN 1 END) as vote_events,
          COUNT(CASE WHEN event_type LIKE '%qc%' THEN 1 END) as qc_events,
          COUNT(CASE WHEN event_type LIKE '%block%' THEN 1 END) as block_events,
          AVG(processing_delay_ms) as avg_processing_time,
          COUNT(DISTINCT validator_id) as participating_validators
        FROM validator_events
        WHERE timestamp >= now() - INTERVAL 1 HOUR
          AND event_type IN ('vote_attempt', 'vote_result', 'qc_commit_attempt', 'block_committed')
        GROUP BY minute
        ORDER BY minute
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const efficiency = await result.json() as any[];
      
      res.json({
        consensus_efficiency: efficiency,
        metadata: {
          timeWindow,
          dataPoints: efficiency.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get consensus efficiency:', error);
      res.status(500).json({
        error: 'Failed to get consensus efficiency',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // THROUGHPUT ANALYSIS
  // =============================================

  async getThroughputAnalysis(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '1h';
      
      const query = `
        SELECT 
          toStartOfMinute(timestamp) as minute,
          COUNT(*) as events_per_minute,
          COUNT(DISTINCT validator_id) as active_validators,
          SUM(transaction_count) as total_transactions,
          AVG(transaction_count) as avg_transactions_per_event
        FROM validator_events
        WHERE timestamp >= now() - INTERVAL 1 HOUR
          AND transaction_count > 0
        GROUP BY minute
        ORDER BY minute
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const throughput = await result.json() as any[];
      
      // Calculate additional metrics
      const totalEvents = throughput.reduce((sum: number, item: any) => sum + item.events_per_minute, 0);
      const avgEventsPerMinute = totalEvents / Math.max(throughput.length, 1);
      const peakEventsPerMinute = Math.max(...throughput.map((item: any) => item.events_per_minute));
      
      res.json({
        throughput,
        summary: {
          total_events: totalEvents,
          avg_events_per_minute: avgEventsPerMinute,
          peak_events_per_minute: peakEventsPerMinute,
          data_points: throughput.length
        },
        metadata: {
          timeWindow
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get throughput analysis:', error);
      res.status(500).json({
        error: 'Failed to get throughput analysis',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // HELPER METHODS
  // =============================================

  private calculateHealthScore(metrics: any): number {
    // Weighted health score calculation
    const weights = {
      validator_activity: 0.25,
      performance: 0.25,
      reliability: 0.30,
      geographic_diversity: 0.10,
      provider_diversity: 0.10
    };

    const scores = {
      validator_activity: Math.min(100, (metrics.active_validators / 50) * 100),
      performance: Math.max(0, 100 - (metrics.avg_processing_delay / 100)),
      reliability: metrics.success_rate,
      geographic_diversity: Math.min(100, (metrics.geographic_diversity / 5) * 100),
      provider_diversity: Math.min(100, (metrics.provider_diversity / 10) * 100)
    };

    const weightedScore = Object.entries(weights).reduce((total, [key, weight]) => {
      return total + (scores[key as keyof typeof scores] * weight);
    }, 0);

    return Math.round(weightedScore * 100) / 100; // Round to 2 decimal places
  }
} 