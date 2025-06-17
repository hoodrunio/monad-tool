// Monad Validator Analytics - Validator Controller
import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export class ValidatorController {
  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {}

  // =============================================
  // VALIDATOR RANKINGS
  // =============================================

  async getValidatorRankings(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '1h';
      const limit = parseInt(req.query.limit as string) || 50;
      const sortBy = (req.query.sortBy as string) || 'total_events';
      
      // Validate parameters
      if (!['1m', '1h', '24h'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1m, 1h, or 24h',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (limit > 1000) {
        res.status(400).json({
          error: 'Invalid limit',
          message: 'Limit must be <= 1000',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Try cache first
      const cacheKey = `validator_rankings:${timeWindow}:${limit}:${sortBy}`;
      const cached = await this.redisClient.getValidatorRankings(cacheKey);
      
      if (cached) {
        res.json({
          data: cached,
          metadata: {
            timeWindow,
            limit,
            sortBy,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Query database
      const rankings = await this.getValidatorRankingsFromDB(timeWindow, limit, sortBy);
      
      // Cache result for 5 minutes
      await this.redisClient.cacheValidatorRankings(cacheKey, rankings, 300);
      
      res.json({
        data: rankings,
        metadata: {
          timeWindow,
          limit,
          sortBy,
          source: 'database',
          count: rankings.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get validator rankings:', error);
      res.status(500).json({
        error: 'Failed to get validator rankings',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // VALIDATOR HISTORY
  // =============================================

  async getValidatorHistory(req: Request, res: Response): Promise<void> {
    try {
      const validatorId = req.params.id;
      const hours = parseInt(req.query.hours as string) || 24;
      const granularity = (req.query.granularity as string) || '1h';
      
      if (!validatorId) {
        res.status(400).json({
          error: 'Missing validator ID',
          message: 'Validator ID is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (hours > 168) { // 7 days max
        res.status(400).json({
          error: 'Invalid time range',
          message: 'Maximum 168 hours (7 days) allowed',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Try cache first
      const cacheKey = `validator_history:${validatorId}:${hours}:${granularity}`;
      const cached = await this.redisClient.getValidatorHistory(validatorId, hours);
      
      if (cached) {
        res.json({
          validatorId,
          history: cached,
          metadata: {
            hours,
            granularity,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Query database
      const history = await this.clickhouseClient.getValidatorHistory(validatorId, hours);
      
      // Cache result for 2 minutes
      await this.redisClient.cacheValidatorHistory(validatorId, hours, history, 120);
      
      res.json({
        validatorId,
        history,
        metadata: {
          hours,
          granularity,
          source: 'database',
          dataPoints: history.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get validator history:', error);
      res.status(500).json({
        error: 'Failed to get validator history',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // VALIDATOR DETAILS
  // =============================================

  async getValidatorDetails(req: Request, res: Response): Promise<void> {
    try {
      const validatorId = req.params.id;
      
      if (!validatorId) {
        res.status(400).json({
          error: 'Missing validator ID',
          message: 'Validator ID is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Get validator details from database
      const query = `
        SELECT 
          validator_id,
          COUNT(*) as total_events,
          COUNT(DISTINCT event_type) as unique_event_types,
          AVG(processing_delay_ms) as avg_processing_delay,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) as successful_events,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) / COUNT(*) * 100 as success_rate,
          MIN(timestamp) as first_seen,
          MAX(timestamp) as last_activity,
          any(geographic_region) as region,
          any(infrastructure_provider) as provider,
          any(datacenter_code) as datacenter,
          any(validator_dns) as dns_name
        FROM validator_events
        WHERE validator_id = '${validatorId}'
          AND timestamp >= now() - INTERVAL 7 DAY
        GROUP BY validator_id
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const details = await result.json() as any[];
      
      if (details.length === 0) {
        res.status(404).json({
          error: 'Validator not found',
          message: `No data found for validator ${validatorId}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      res.json({
        validator: details[0],
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get validator details:', error);
      res.status(500).json({
        error: 'Failed to get validator details',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // VALIDATOR PERFORMANCE METRICS
  // =============================================

  async getValidatorPerformance(req: Request, res: Response): Promise<void> {
    try {
      const validatorId = req.params.id;
      const timeWindow = (req.query.window as string) || '24h';
      
      if (!validatorId) {
        res.status(400).json({
          error: 'Missing validator ID',
          message: 'Validator ID is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const query = `
        SELECT 
          toStartOfHour(timestamp) as hour,
          COUNT(*) as events_count,
          COUNT(DISTINCT event_type) as event_types_count,
          AVG(processing_delay_ms) as avg_processing_delay,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) as successful_events,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) / COUNT(*) * 100 as success_rate
        FROM validator_events
        WHERE validator_id = '${validatorId}'
          AND timestamp >= now() - INTERVAL 24 HOUR
        GROUP BY hour
        ORDER BY hour
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const performance = await result.json() as any[];
      
      res.json({
        validatorId,
        performance,
        metadata: {
          timeWindow,
          dataPoints: performance.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get validator performance:', error);
      res.status(500).json({
        error: 'Failed to get validator performance',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // HELPER METHODS
  // =============================================

  private async getValidatorRankingsFromDB(timeWindow: string, limit: number, sortBy: string): Promise<any[]> {
    let intervalClause = '24 HOUR';
    
    switch (timeWindow) {
      case '1m':
        intervalClause = '1 HOUR';
        break;
      case '1h':
        intervalClause = '24 HOUR';
        break;
      case '24h':
        intervalClause = '7 DAY';
        break;
    }

    let orderByClause = 'total_events DESC, success_rate DESC';
    
    switch (sortBy) {
      case 'success_rate':
        orderByClause = 'success_rate DESC, total_events DESC';
        break;
      case 'processing_delay':
        orderByClause = 'avg_processing_delay ASC';
        break;
      case 'last_activity':
        orderByClause = 'last_activity DESC';
        break;
    }

    const query = `
      SELECT 
        validator_id,
        COUNT(*) as total_events,
        COUNT(DISTINCT event_type) as event_types,
        AVG(processing_delay_ms) as avg_processing_delay,
        COUNT(CASE WHEN is_successful = 1 THEN 1 END) as successful_events,
        COUNT(CASE WHEN is_successful = 1 THEN 1 END) / COUNT(*) * 100 as success_rate,
        MAX(timestamp) as last_activity,
        any(geographic_region) as region,
        any(infrastructure_provider) as provider,
        any(datacenter_code) as datacenter
      FROM validator_events
      WHERE timestamp >= now() - INTERVAL ${intervalClause}
        AND validator_id != 'unknown'
      GROUP BY validator_id
      ORDER BY ${orderByClause}
      LIMIT ${limit}
    `;

    const result = await this.clickhouseClient['client'].query({
      query,
      format: 'JSONEachRow'
    });

    return result.json();
  }
} 