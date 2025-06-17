// Monad Validator Analytics - Event Controller
import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export class EventController {
  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {}

  // =============================================
  // RECENT EVENTS
  // =============================================

  async getRecentEvents(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const eventType = req.query.type as string;
      const validatorId = req.query.validator as string;
      const minRound = parseInt(req.query.minRound as string);
      
      // Validate limit
      if (limit > 1000) {
        res.status(400).json({
          error: 'Invalid limit',
          message: 'Limit must be <= 1000',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Build query with optional filters
      let whereClause = 'WHERE 1=1';
      const params: string[] = [];
      
      if (eventType) {
        whereClause += ` AND event_type = ?`;
        params.push(eventType);
      }
      
      if (validatorId) {
        whereClause += ` AND validator_id = ?`;
        params.push(validatorId);
      }
      
      if (minRound) {
        whereClause += ` AND round_number >= ?`;
        params.push(minRound.toString());
      }

      let query = `
        SELECT 
          timestamp,
          event_type,
          validator_id,
          round_number,
          epoch_number,
          block_number,
          is_successful,
          processing_delay_ms,
          geographic_region,
          infrastructure_provider
        FROM validator_events
        ${whereClause}
        ORDER BY timestamp DESC 
        LIMIT ${limit}
      `;

      // For ClickHouse, we'll use string interpolation for simplicity
      // In production, you'd want proper parameterized queries
      if (eventType) {
        query = query.replace('event_type = ?', `event_type = '${eventType}'`);
      }
      if (validatorId) {
        query = query.replace('validator_id = ?', `validator_id = '${validatorId}'`);
      }
      if (minRound) {
        query = query.replace('round_number >= ?', `round_number >= ${minRound}`);
      }

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const events = await result.json() as any[];
      
      res.json({
        events,
        metadata: {
          count: events.length,
          limit,
          filters: {
            eventType: eventType || null,
            validatorId: validatorId || null,
            minRound: minRound || null
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get recent events:', error);
      res.status(500).json({
        error: 'Failed to get recent events',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // EVENT TYPES STATISTICS
  // =============================================

  async getEventTypes(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      
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

      const query = `
        SELECT 
          event_type,
          COUNT(*) as count,
          COUNT(DISTINCT validator_id) as unique_validators,
          AVG(processing_delay_ms) as avg_delay,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) as successful_count,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) / COUNT(*) * 100 as success_rate,
          MIN(timestamp) as first_occurrence,
          MAX(timestamp) as last_occurrence
        FROM validator_events
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
        GROUP BY event_type
        ORDER BY count DESC
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const eventTypes = await result.json() as any[];
      
      res.json({
        eventTypes,
        metadata: {
          timeWindow,
          totalTypes: eventTypes.length,
          totalEvents: eventTypes.reduce((sum: number, et: any) => sum + et.count, 0)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get event types:', error);
      res.status(500).json({
        error: 'Failed to get event types',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // EVENT TIMELINE
  // =============================================

  async getEventTimeline(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '1h';
      const granularity = (req.query.granularity as string) || '1m';
      const eventType = req.query.eventType as string;
      
      let intervalClause = '1 HOUR';
      let timeGrouping = 'toStartOfMinute(timestamp)';
      
      switch (timeWindow) {
        case '1h':
          intervalClause = '1 HOUR';
          timeGrouping = granularity === '1s' ? 'toStartOfInterval(timestamp, INTERVAL 10 SECOND)' : 'toStartOfMinute(timestamp)';
          break;
        case '24h':
          intervalClause = '24 HOUR';
          timeGrouping = granularity === '1m' ? 'toStartOfMinute(timestamp)' : 'toStartOfHour(timestamp)';
          break;
        case '7d':
          intervalClause = '7 DAY';
          timeGrouping = 'toStartOfHour(timestamp)';
          break;
      }

      let whereClause = `WHERE timestamp >= now() - INTERVAL ${intervalClause}`;
      if (eventType) {
        whereClause += ` AND event_type = '${eventType}'`;
      }

      const query = `
        SELECT 
          ${timeGrouping} as time_bucket,
          COUNT(*) as event_count,
          COUNT(DISTINCT validator_id) as unique_validators,
          COUNT(DISTINCT event_type) as unique_event_types,
          AVG(processing_delay_ms) as avg_processing_delay,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) as successful_events
        FROM validator_events
        ${whereClause}
        GROUP BY time_bucket
        ORDER BY time_bucket
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const timeline = await result.json() as any[];
      
      res.json({
        timeline,
        metadata: {
          timeWindow,
          granularity,
          eventType: eventType || 'all',
          dataPoints: timeline.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get event timeline:', error);
      res.status(500).json({
        error: 'Failed to get event timeline',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // EVENT SEARCH
  // =============================================

  async searchEvents(req: Request, res: Response): Promise<void> {
    try {
      const {
        query: searchQuery,
        eventType,
        validatorId,
        startTime,
        endTime,
        limit = 100,
        offset = 0
      } = req.query;

      if (!searchQuery && !eventType && !validatorId) {
        res.status(400).json({
          error: 'Missing search criteria',
          message: 'At least one of: query, eventType, or validatorId is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      let whereConditions: string[] = [];
      
      if (eventType) {
        whereConditions.push(`event_type = '${eventType}'`);
      }
      
      if (validatorId) {
        whereConditions.push(`validator_id = '${validatorId}'`);
      }
      
      if (startTime) {
        whereConditions.push(`timestamp >= '${startTime}'`);
      }
      
      if (endTime) {
        whereConditions.push(`timestamp <= '${endTime}'`);
      }
      
      if (searchQuery) {
        whereConditions.push(`(
          metadata LIKE '%${searchQuery}%' OR 
          validator_dns LIKE '%${searchQuery}%' OR
          geographic_region LIKE '%${searchQuery}%'
        )`);
      }

      const whereClause = whereConditions.length > 0 ? 
        `WHERE ${whereConditions.join(' AND ')}` : '';

      const query = `
        SELECT 
          timestamp,
          event_type,
          validator_id,
          round_number,
          epoch_number,
          block_number,
          is_successful,
          processing_delay_ms,
          geographic_region,
          infrastructure_provider,
          validator_dns,
          metadata
        FROM validator_events
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const events = await result.json() as any[];
      
      res.json({
        events,
        metadata: {
          searchQuery: searchQuery || null,
          filters: {
            eventType: eventType || null,
            validatorId: validatorId || null,
            startTime: startTime || null,
            endTime: endTime || null
          },
          pagination: {
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: events.length === parseInt(limit as string)
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to search events:', error);
      res.status(500).json({
        error: 'Failed to search events',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // EVENT STATISTICS
  // =============================================

  async getEventStatistics(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      
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

      const query = `
        SELECT 
          COUNT(*) as total_events,
          COUNT(DISTINCT event_type) as unique_event_types,
          COUNT(DISTINCT validator_id) as active_validators,
          COUNT(DISTINCT round_number) as unique_rounds,
          AVG(processing_delay_ms) as avg_processing_delay,
          MIN(processing_delay_ms) as min_processing_delay,
          MAX(processing_delay_ms) as max_processing_delay,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) as successful_events,
          COUNT(CASE WHEN is_successful = 0 THEN 1 END) as failed_events,
          COUNT(CASE WHEN is_successful = 1 THEN 1 END) / COUNT(*) * 100 as success_rate
        FROM validator_events
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const statistics = await result.json() as any[];
      
      res.json({
        statistics: statistics[0],
        metadata: {
          timeWindow
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get event statistics:', error);
      res.status(500).json({
        error: 'Failed to get event statistics',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }
} 