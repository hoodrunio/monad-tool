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

      // Get block proposal summary
      const blockSummaryQuery = `
        SELECT 
          COUNT(*) as total_block_events,
          COUNT(DISTINCT validator_id) as unique_validators_blocks,
          COUNT(DISTINCT toDate(timestamp)) as active_days_blocks,
          MAX(timestamp) as latest_block_event,
          MIN(timestamp) as earliest_block_event,
          COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_block_events,
          (COUNT(CASE WHEN status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as block_success_rate
        FROM block_proposals
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
      `;

      // Get QC participation summary
      const qcSummaryQuery = `
        SELECT 
          COUNT(*) as total_qc_events,
          COUNT(DISTINCT validator_id) as unique_validators_qc,
          COUNT(DISTINCT toDate(timestamp)) as active_days_qc,
          MAX(timestamp) as latest_qc_event,
          MIN(timestamp) as earliest_qc_event,
          COUNT(CASE WHEN participated = 1 THEN 1 END) as successful_qc_events,
          (COUNT(CASE WHEN participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as qc_success_rate,
          AVG(participation_rate) as avg_network_participation_rate
        FROM qc_participation
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
      `;

      const [blockResult, qcResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(blockSummaryQuery),
        this.clickhouseClient.executeRawQuery(qcSummaryQuery)
      ]);

      const [blockSummary] = blockResult;
      const [qcSummary] = qcResult;

      const summary = {
        total_events: (parseInt(blockSummary?.total_block_events || 0)) + (parseInt(qcSummary?.total_qc_events || 0)),
        unique_validators: Math.max(parseInt(blockSummary?.unique_validators_blocks || 0), parseInt(qcSummary?.unique_validators_qc || 0)),
        event_types: 3, // block_proposal, block_skipped, qc_participation
        active_days: Math.max(parseInt(blockSummary?.active_days_blocks || 0), parseInt(qcSummary?.active_days_qc || 0)),
        avg_processing_delay: 0, // Not available in new schema
        latest_event: blockSummary?.latest_block_event > qcSummary?.latest_qc_event ? 
          blockSummary?.latest_block_event : qcSummary?.latest_qc_event,
        earliest_event: blockSummary?.earliest_block_event < qcSummary?.earliest_qc_event ? 
          blockSummary?.earliest_block_event : qcSummary?.earliest_qc_event,
        successful_events: (parseInt(blockSummary?.successful_block_events || 0)) + (parseInt(qcSummary?.successful_qc_events || 0)),
        overall_success_rate: ((parseFloat(blockSummary?.block_success_rate || 0)) + (parseFloat(qcSummary?.qc_success_rate || 0))) / 2,
        block_proposal_metrics: {
          total_proposals: parseInt(blockSummary?.total_block_events || 0),
          successful_proposals: parseInt(blockSummary?.successful_block_events || 0),
          success_rate: parseFloat(blockSummary?.block_success_rate || 0)
        },
        qc_participation_metrics: {
          total_participations: parseInt(qcSummary?.total_qc_events || 0),
          successful_participations: parseInt(qcSummary?.successful_qc_events || 0),
          success_rate: parseFloat(qcSummary?.qc_success_rate || 0),
          avg_network_participation_rate: parseFloat(qcSummary?.avg_network_participation_rate || 0)
        }
      };
      
      // Cache result for 2 minutes
      await this.redisClient['client'].setex(cacheKey, 120, JSON.stringify(summary));
      
      res.json({
        summary,
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
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          metrics: JSON.parse(cached),
          metadata: {
            timeWindow,
            granularity,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Calculate interval and time grouping based on request
      let intervalClause = '1 HOUR';
      let timeGrouping = 'toStartOfMinute(timestamp)';
      
      switch (validatedTimeWindow) {
        case '1m':
          intervalClause = '1 MINUTE';
          timeGrouping = 'toStartOfSecond(timestamp)';
          break;
        case '1h':
          intervalClause = '1 HOUR';
          timeGrouping = 'toStartOfMinute(timestamp)';
          break;
        case '24h':
          intervalClause = '24 HOUR';
          timeGrouping = 'toStartOfHour(timestamp)';
          break;
      }

      // Get time-series block proposal metrics
      const blockMetricsQuery = `
        SELECT 
          ${timeGrouping} as time_bucket,
          COUNT(*) as total_block_events,
          COUNT(DISTINCT validator_id) as active_validators,
          COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_blocks,
          COUNT(CASE WHEN status = 'skipped' THEN 1 END) as skipped_blocks,
          (COUNT(CASE WHEN status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as block_success_rate
        FROM block_proposals
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
        GROUP BY time_bucket
        ORDER BY time_bucket
      `;

      // Get time-series QC participation metrics
      const qcMetricsQuery = `
        SELECT 
          ${timeGrouping} as time_bucket,
          COUNT(*) as total_qc_events,
          COUNT(DISTINCT validator_id) as active_validators_qc,
          COUNT(CASE WHEN participated = 1 THEN 1 END) as successful_participations,
          COUNT(CASE WHEN participated = 0 THEN 1 END) as missed_participations,
          (COUNT(CASE WHEN participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as qc_success_rate,
          AVG(participation_rate) as avg_network_participation_rate
        FROM qc_participation
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
        GROUP BY time_bucket
        ORDER BY time_bucket
      `;

      const [blockResult, qcResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(blockMetricsQuery),
        this.clickhouseClient.executeRawQuery(qcMetricsQuery)
      ]);

      const blockMetrics = blockResult;
      const qcMetrics = qcResult;

      // Merge metrics by time bucket
      const metricsMap = new Map<string, any>();
      
      blockMetrics.forEach(b => {
        metricsMap.set(b.time_bucket, {
          time_bucket: b.time_bucket,
          total_events: parseInt(b.total_block_events),
          active_validators: parseInt(b.active_validators),
          block_metrics: {
            total_blocks: parseInt(b.total_block_events),
            successful_blocks: parseInt(b.successful_blocks),
            skipped_blocks: parseInt(b.skipped_blocks),
            success_rate: parseFloat(b.block_success_rate)
          },
          qc_metrics: {
            total_participations: 0,
            successful_participations: 0,
            missed_participations: 0,
            success_rate: 0,
            avg_network_participation_rate: 0
          }
        });
      });

      qcMetrics.forEach(q => {
        const existing = metricsMap.get(q.time_bucket) || {
          time_bucket: q.time_bucket,
          total_events: 0,
          active_validators: 0,
          block_metrics: {
            total_blocks: 0,
            successful_blocks: 0,
            skipped_blocks: 0,
            success_rate: 0
          }
        };
        
        existing.total_events += parseInt(q.total_qc_events);
        existing.active_validators = Math.max(existing.active_validators, parseInt(q.active_validators_qc));
        existing.qc_metrics = {
          total_participations: parseInt(q.total_qc_events),
          successful_participations: parseInt(q.successful_participations),
          missed_participations: parseInt(q.missed_participations),
          success_rate: parseFloat(q.qc_success_rate),
          avg_network_participation_rate: parseFloat(q.avg_network_participation_rate)
        };
        
        metricsMap.set(q.time_bucket, existing);
      });

      const metrics = Array.from(metricsMap.values()).sort((a, b) => a.time_bucket.localeCompare(b.time_bucket));
      
      // Cache result for 1 minute
      await this.redisClient['client'].setex(cacheKey, 60, JSON.stringify(metrics));
      
      res.json({
        metrics,
        metadata: {
          timeWindow,
          granularity,
          source: 'database',
          dataPoints: metrics.length
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
      const cached = await this.redisClient['client'].get('geographic_distribution');
      
      if (cached) {
        res.json({
          distribution: JSON.parse(cached),
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

      // Get geographic distribution from block proposals
      const blockGeoQuery = `
        SELECT 
          location,
          COUNT(DISTINCT validator_id) as validator_count,
          COUNT(*) as total_events,
          COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_events,
          (COUNT(CASE WHEN status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as success_rate
        FROM block_proposals
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
          AND location IS NOT NULL 
          AND location != ''
        GROUP BY location
      `;

      // Get geographic distribution from QC participation (for cross-validation)
      const qcGeoQuery = `
        SELECT 
          location,
          COUNT(DISTINCT validator_id) as validator_count,
          COUNT(*) as total_events,
          COUNT(CASE WHEN participated = 1 THEN 1 END) as successful_events,
          (COUNT(CASE WHEN participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as success_rate
        FROM qc_participation
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
          AND location IS NOT NULL 
          AND location != ''
        GROUP BY location
      `;

      const [blockResult, qcResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(blockGeoQuery),
        this.clickhouseClient.executeRawQuery(qcGeoQuery)
      ]);

      const blockGeoData = blockResult;
      const qcGeoData = qcResult;

      // Combine geographic data from both sources
      const geoMap = new Map<string, any>();
      
      blockGeoData.forEach(b => {
        geoMap.set(b.location, {
          location: b.location,
          validator_count: parseInt(b.validator_count),
          block_events: parseInt(b.total_events),
          block_success_rate: parseFloat(b.success_rate),
          qc_events: 0,
          qc_success_rate: 0,
          total_events: parseInt(b.total_events)
        });
      });

      qcGeoData.forEach(q => {
        const existing = geoMap.get(q.location) || {
          location: q.location,
          validator_count: parseInt(q.validator_count),
          block_events: 0,
          block_success_rate: 0,
          total_events: 0
        };
        
        existing.validator_count = Math.max(existing.validator_count, parseInt(q.validator_count));
        existing.qc_events = parseInt(q.total_events);
        existing.qc_success_rate = parseFloat(q.success_rate);
        existing.total_events += parseInt(q.total_events);
        
        geoMap.set(q.location, existing);
      });

      const distribution = Array.from(geoMap.values())
        .map(d => ({
          location: d.location,
          validator_count: d.validator_count,
          total_events: d.total_events,
          block_events: d.block_events,
          qc_events: d.qc_events,
          block_success_rate: d.block_success_rate,
          qc_success_rate: d.qc_success_rate,
          overall_success_rate: d.total_events > 0 ? 
            ((d.block_events * d.block_success_rate / 100) + (d.qc_events * d.qc_success_rate / 100)) / d.total_events * 100 : 0
        }))
        .sort((a, b) => b.validator_count - a.validator_count);
      
      // Cache result for 5 minutes
      await this.redisClient['client'].setex('geographic_distribution', 300, JSON.stringify(distribution));
      
      res.json({
        distribution,
        metadata: {
          timeWindow,
          source: 'database',
          regions: distribution.length,
          total_validators: distribution.reduce((sum, d) => sum + d.validator_count, 0)
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

      const result = await this.clickhouseClient.executeRawQuery(query);

      const metrics = result;
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
          COUNT(CASE WHEN toString(event_type) LIKE '%vote%' THEN 1 END) as vote_events,
          COUNT(CASE WHEN toString(event_type) LIKE '%qc%' THEN 1 END) as qc_events,
          COUNT(CASE WHEN toString(event_type) LIKE '%block%' THEN 1 END) as block_events,
          AVG(processing_delay_ms) as avg_processing_time,
          COUNT(DISTINCT validator_id) as participating_validators
        FROM validator_events
        WHERE timestamp >= now() - INTERVAL 1 HOUR
          AND event_type IN ('vote_attempt', 'vote_result', 'qc_commit_attempt', 'block_committed')
        GROUP BY minute
        ORDER BY minute
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      const efficiency = result
      
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

      const result = await this.clickhouseClient.executeRawQuery(query);

      const throughput = result;
      
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