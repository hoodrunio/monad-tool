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
  // RECENT EVENTS (Combined from both tables)
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

      // Parse comma-separated event types
      const requestedEventTypes: string[] = eventType ? 
        (typeof eventType === 'string' ? eventType.split(',').map(t => t.trim()) : []) : 
        [];

      // Helper function to check if we should query block proposals table
      const shouldQueryBlockProposals = (): boolean => {
        if (!eventType) return true; // No filter means include all
        return requestedEventTypes.some(type => 
          type === 'block_proposal' || type === 'block_skipped' || type.includes('block')
        );
      };

      // Helper function to check if we should query QC participation table
      const shouldQueryQcParticipation = (): boolean => {
        if (!eventType) return true; // No filter means include all
        return requestedEventTypes.includes('qc_participation');
      };

      // Helper function to get block status filter
      const getBlockStatusFilter = (): string => {
        const statusFilters: string[] = [];
        if (requestedEventTypes.includes('block_proposal')) {
          statusFilters.push("bp.status = 'proposed'");
        }
        if (requestedEventTypes.includes('block_skipped')) {
          statusFilters.push("bp.status = 'skipped'");
        }
        // If no specific status is requested but block events are requested, include all statuses
        if (requestedEventTypes.some(type => type.includes('block')) && 
            !requestedEventTypes.includes('block_proposal') && 
            !requestedEventTypes.includes('block_skipped')) {
          return ''; // No status filter
        }
        return statusFilters.length > 0 ? ` AND (${statusFilters.join(' OR ')})` : '';
      };

      let whereClause = 'WHERE 1=1';
      
      if (validatorId) {
        whereClause += ` AND validator_id = '${validatorId}'`;
      }
      
      if (minRound) {
        whereClause += ` AND round >= ${minRound}`;
      }

      let blockEvents: any[] = [];
      let qcEvents: any[] = [];

      // Get block proposal events
      if (shouldQueryBlockProposals()) {
        // Build where clause with table prefix for block proposals
        let blockWhereClause = 'WHERE 1=1';
        if (validatorId) {
          blockWhereClause += ` AND bp.validator_id = '${validatorId}'`;
        }
        if (minRound) {
          blockWhereClause += ` AND bp.round >= ${minRound}`;
        }
        blockWhereClause += getBlockStatusFilter();

        const blockQuery = `
          SELECT 
            bp.timestamp,
            'block_proposal' as event_type,
            bp.validator_id,
            bp.round,
            bp.epoch,
            bp.seq_num,
            bp.status,
            bp.num_tx,
            bp.block_id,
            COALESCE(vr.validator_name, 'unknown') as validator_name,
            COALESCE(vr.provider, 'unknown') as provider,
            COALESCE(vr.location, 'unknown') as location
          FROM block_proposals bp
          LEFT JOIN validator_registry vr ON bp.validator_id = vr.validator_id
          ${blockWhereClause}
          ORDER BY bp.timestamp DESC 
          LIMIT ${Math.min(limit, 500)}
        `;

        const blockResult = await this.clickhouseClient.executeRawQuery(blockQuery);

        blockEvents = blockResult
      }

      // Get QC participation events
      if (shouldQueryQcParticipation()) {
        // Build where clause with table prefix for QC participation
        let qcWhereClause = 'WHERE 1=1';
        if (validatorId) {
          qcWhereClause += ` AND qc.validator_id = '${validatorId}'`;
        }
        if (minRound) {
          qcWhereClause += ` AND qc.round >= ${minRound}`;
        }

        const qcQuery = `
          SELECT 
            qc.timestamp,
            'qc_participation' as event_type,
            qc.validator_id,
            qc.round,
            qc.epoch,
            qc.seq_num,
            qc.participated,
            qc.validator_index,
            qc.participation_rate,
            COALESCE(vr.validator_name, 'unknown') as validator_name,
            COALESCE(vr.provider, 'unknown') as provider,
            COALESCE(vr.location, 'unknown') as location
          FROM qc_participation qc
          LEFT JOIN validator_registry vr ON qc.validator_id = vr.validator_id
          ${qcWhereClause}
          ORDER BY qc.timestamp DESC 
          LIMIT ${Math.min(limit, 500)}
        `;

        const qcResult = await this.clickhouseClient.executeRawQuery(qcQuery);

        qcEvents = qcResult;
      }

      // Combine and sort events
      const allEvents = [
        ...blockEvents.map(e => ({
          timestamp: e.timestamp,
          event_type: e.status === 'proposed' ? 'block_proposal' : 'block_skipped',
          validator_id: e.validator_id,
          round_number: parseInt(e.round),
          epoch_number: parseInt(e.epoch),
          sequence_number: parseInt(e.seq_num),
          details: {
            status: e.status,
            num_tx: e.num_tx,
            block_id: e.block_id
          },
          infrastructure: {
            validator_name: e.validator_name,
            provider: e.provider,
            location: e.location
          }
        })),
        ...qcEvents.map(e => ({
          timestamp: e.timestamp,
          event_type: 'qc_participation',
          validator_id: e.validator_id,
          round_number: parseInt(e.round),
          epoch_number: parseInt(e.epoch),
          sequence_number: parseInt(e.seq_num),
          details: {
            participated: e.participated === 1,
            validator_index: e.validator_index,
            participation_rate: parseFloat(e.participation_rate)
          },
          infrastructure: {
            validator_name: e.validator_name,
            provider: e.provider,
            location: e.location
          }
        }))]

      // Sort by timestamp and limit
      const sortedEvents = allEvents
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit);
      
      res.json({
        events: sortedEvents,
        metadata: {
          count: sortedEvents.length,
          limit,
          filters: {
            eventType: eventType || null,
            requestedEventTypes: requestedEventTypes.length > 0 ? requestedEventTypes : null,
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

      // Get block proposal statistics
      const blockStatsQuery = `
        SELECT 
          CASE 
            WHEN status = 'proposed' THEN 'block_proposal'
            WHEN status = 'skipped' THEN 'block_skipped'
            ELSE 'unknown'
          END as event_type,
          COUNT(*) as count,
          COUNT(DISTINCT validator_id) as unique_validators,
          0 as avg_delay,  -- Not available for block proposals
          COUNT(*) as successful_count,  -- All block events are "successful" in terms of being recorded
          100.0 as success_rate,
          MIN(timestamp) as first_occurrence,
          MAX(timestamp) as last_occurrence
        FROM block_proposals
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
        GROUP BY status
      `;

      // Get QC participation statistics
      const qcStatsQuery = `
        SELECT 
          'qc_participation' as event_type,
          COUNT(*) as count,
          COUNT(DISTINCT validator_id) as unique_validators,
          0 as avg_delay,  -- Not available for QC participation
          COUNT(CASE WHEN participated = 1 THEN 1 END) as successful_count,
          (COUNT(CASE WHEN participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as success_rate,
          MIN(timestamp) as first_occurrence,
          MAX(timestamp) as last_occurrence
        FROM qc_participation
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
      `;

      const [blockResult, qcResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(blockStatsQuery),
        this.clickhouseClient.executeRawQuery(qcStatsQuery)
      ]);

      const blockStats = blockResult;
      const qcStats = qcResult;

      const eventTypes = [...blockStats, ...qcStats].map(et => ({
        event_type: et.event_type,
        count: parseInt(et.count),
        unique_validators: parseInt(et.unique_validators),
        avg_delay: parseFloat(et.avg_delay || 0),
        successful_count: parseInt(et.successful_count),
        success_rate: parseFloat(et.success_rate),
        first_occurrence: et.first_occurrence,
        last_occurrence: et.last_occurrence
      }));
      
      res.json({
        eventTypes,
        metadata: {
          timeWindow,
          totalTypes: eventTypes.length,
          totalEvents: eventTypes.reduce((sum, et) => sum + et.count, 0)
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

      // Parse comma-separated event types
      const requestedEventTypes: string[] = eventType ? 
        (typeof eventType === 'string' ? eventType.split(',').map(t => t.trim()) : []) : 
        [];

      // Helper function to check if we should query block proposals table
      const shouldQueryBlockProposals = (): boolean => {
        if (!eventType) return true; // No filter means include all
        return requestedEventTypes.some(type => 
          type === 'block_proposal' || type === 'block_skipped' || type.includes('block')
        );
      };

      // Helper function to check if we should query QC participation table
      const shouldQueryQcParticipation = (): boolean => {
        if (!eventType) return true; // No filter means include all
        return requestedEventTypes.includes('qc_participation');
      };

      // Helper function to get block status filter
      const getBlockStatusFilter = (): string => {
        const statusFilters: string[] = [];
        if (requestedEventTypes.includes('block_proposal')) {
          statusFilters.push("status = 'proposed'");
        }
        if (requestedEventTypes.includes('block_skipped')) {
          statusFilters.push("status = 'skipped'");
        }
        // If no specific status is requested but block events are requested, include all statuses
        if (requestedEventTypes.some(type => type.includes('block')) && 
            !requestedEventTypes.includes('block_proposal') && 
            !requestedEventTypes.includes('block_skipped')) {
          return ''; // No status filter
        }
        return statusFilters.length > 0 ? ` AND (${statusFilters.join(' OR ')})` : '';
      };

      let blockTimelineQuery = '';
      let qcTimelineQuery = '';

      // Build block proposal timeline query
      if (shouldQueryBlockProposals()) {
        let blockWhereClause = `WHERE timestamp >= now() - INTERVAL ${intervalClause}`;
        blockWhereClause += getBlockStatusFilter();

        blockTimelineQuery = `
          SELECT 
            ${timeGrouping} as time_bucket,
            COUNT(*) as event_count,
            COUNT(DISTINCT validator_id) as unique_validators,
            1 as unique_event_types,
            0 as avg_processing_delay,
            COUNT(*) as successful_events
          FROM block_proposals
          ${blockWhereClause}
          GROUP BY time_bucket
        `;
      }

      // Build QC participation timeline query
      if (shouldQueryQcParticipation()) {
        qcTimelineQuery = `
          SELECT 
            ${timeGrouping} as time_bucket,
            COUNT(*) as event_count,
            COUNT(DISTINCT validator_id) as unique_validators,
            1 as unique_event_types,
            0 as avg_processing_delay,
            COUNT(CASE WHEN participated = 1 THEN 1 END) as successful_events
          FROM qc_participation
          WHERE timestamp >= now() - INTERVAL ${intervalClause}
          GROUP BY time_bucket
        `;
      }

      let timeline: any[] = [];

      if (blockTimelineQuery && qcTimelineQuery) {
        // Combine both queries
        const combinedQuery = `
          WITH block_timeline AS (${blockTimelineQuery}),
               qc_timeline AS (${qcTimelineQuery})
          SELECT 
            COALESCE(b.time_bucket, q.time_bucket) as time_bucket,
            COALESCE(b.event_count, 0) + COALESCE(q.event_count, 0) as event_count,
            GREATEST(COALESCE(b.unique_validators, 0), COALESCE(q.unique_validators, 0)) as unique_validators,
            COALESCE(b.unique_event_types, 0) + COALESCE(q.unique_event_types, 0) as unique_event_types,
            0 as avg_processing_delay,
            COALESCE(b.successful_events, 0) + COALESCE(q.successful_events, 0) as successful_events
          FROM block_timeline b
          FULL OUTER JOIN qc_timeline q ON b.time_bucket = q.time_bucket
          ORDER BY time_bucket
        `;

        const result = await this.clickhouseClient.executeRawQuery(combinedQuery);

        timeline = result;
      } else if (blockTimelineQuery) {
        const result = await this.clickhouseClient.executeRawQuery(blockTimelineQuery);
        timeline = result;
      } else if (qcTimelineQuery) {
        const result = await this.clickhouseClient.executeRawQuery(qcTimelineQuery);
        timeline = result;
      }
      
      res.json({
        timeline,
        metadata: {
          timeWindow,
          granularity,
          eventType: eventType || 'all',
          requestedEventTypes: requestedEventTypes.length > 0 ? requestedEventTypes : null,
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

      // Parse comma-separated event types
      const requestedEventTypes: string[] = eventType ? 
        (typeof eventType === 'string' ? eventType.split(',').map(t => t.trim()) : []) : 
        [];

      // Helper function to check if we should query block proposals table
      const shouldQueryBlockProposals = (): boolean => {
        if (!eventType) return true; // No filter means include all
        return requestedEventTypes.some(type => 
          type === 'block_proposal' || type === 'block_skipped' || type.includes('block')
        );
      };

      // Helper function to check if we should query QC participation table
      const shouldQueryQcParticipation = (): boolean => {
        if (!eventType) return true; // No filter means include all
        return requestedEventTypes.includes('qc_participation');
      };

      // Helper function to get block status filter
      const getBlockStatusFilter = (): string[] => {
        const statusFilters: string[] = [];
        if (requestedEventTypes.includes('block_proposal')) {
          statusFilters.push("bp.status = 'proposed'");
        }
        if (requestedEventTypes.includes('block_skipped')) {
          statusFilters.push("bp.status = 'skipped'");
        }
        // If no specific status is requested but block events are requested, include all statuses
        if (requestedEventTypes.some(type => type.includes('block')) && 
            !requestedEventTypes.includes('block_proposal') && 
            !requestedEventTypes.includes('block_skipped')) {
          return []; // No status filter
        }
        return statusFilters;
      };

      let whereConditions: string[] = [];
      
      if (validatorId) {
        whereConditions.push(`validator_id = '${validatorId}'`);
      }
      
      if (startTime) {
        whereConditions.push(`timestamp >= '${startTime}'`);
      }
      
      if (endTime) {
        whereConditions.push(`timestamp <= '${endTime}'`);
      }

      let events: any[] = [];

      // Search block proposals
      if (shouldQueryBlockProposals()) {
        let blockWhereConditions = [];
        
        if (validatorId) {
          blockWhereConditions.push(`bp.validator_id = '${validatorId}'`);
        }
        
        if (startTime) {
          blockWhereConditions.push(`bp.timestamp >= '${startTime}'`);
        }
        
        if (endTime) {
          blockWhereConditions.push(`bp.timestamp <= '${endTime}'`);
        }
        
        // Add status filters for specific event types
        const statusFilters = getBlockStatusFilter();
        if (statusFilters.length > 0) {
          blockWhereConditions.push(`(${statusFilters.join(' OR ')})`);
        }

        if (searchQuery) {
          blockWhereConditions.push(`(
            COALESCE(vr.provider, 'unknown') LIKE '%${searchQuery}%' OR 
            COALESCE(vr.location, 'unknown') LIKE '%${searchQuery}%' OR
            COALESCE(toString(bp.block_id), '') LIKE '%${searchQuery}%'
          )`);
        }

        const blockWhereClause = blockWhereConditions.length > 0 ? 
          `WHERE ${blockWhereConditions.join(' AND ')}` : '';

        const blockQuery = `
          SELECT 
            bp.timestamp,
            'block_proposal' as event_type,
            bp.validator_id,
            bp.round,
            bp.epoch,
            bp.seq_num,
            bp.status,
            bp.num_tx,
            bp.block_id,
            COALESCE(vr.validator_name, 'unknown') as validator_name,
            COALESCE(vr.provider, 'unknown') as provider,
            COALESCE(vr.location, 'unknown') as location
          FROM block_proposals bp
          LEFT JOIN validator_registry vr ON bp.validator_id = vr.validator_id
          ${blockWhereClause}
          ORDER BY bp.timestamp DESC
          LIMIT ${parseInt(limit as string)}
          OFFSET ${parseInt(offset as string)}
        `;

        const blockResult = await this.clickhouseClient.executeRawQuery(blockQuery);

        const blockEvents = blockResult;
        events.push(...blockEvents.map(e => ({
          timestamp: e.timestamp,
          event_type: e.status === 'proposed' ? 'block_proposal' : 'block_skipped',
          validator_id: e.validator_id,
          round_number: parseInt(e.round),
          epoch_number: parseInt(e.epoch),
          sequence_number: parseInt(e.seq_num),
          details: {
            status: e.status,
            num_tx: e.num_tx,
            block_id: e.block_id
          },
          infrastructure: {
            validator_name: e.validator_name,
            provider: e.provider,
            location: e.location
          }
        })));
      }

      // Search QC participation
      if (shouldQueryQcParticipation()) {
        let qcWhereConditions = [];

        if (validatorId) {
          qcWhereConditions.push(`qc.validator_id = '${validatorId}'`);
        }
        
        if (startTime) {
          qcWhereConditions.push(`qc.timestamp >= '${startTime}'`);
        }
        
        if (endTime) {
          qcWhereConditions.push(`qc.timestamp <= '${endTime}'`);
        }

        if (searchQuery) {
          qcWhereConditions.push(`(
            COALESCE(vr.provider, 'unknown') LIKE '%${searchQuery}%' OR 
            COALESCE(vr.location, 'unknown') LIKE '%${searchQuery}%'
          )`);
        }

        const qcWhereClause = qcWhereConditions.length > 0 ? 
          `WHERE ${qcWhereConditions.join(' AND ')}` : '';

        const qcQuery = `
          SELECT 
            qc.timestamp,
            'qc_participation' as event_type,
            qc.validator_id,
            qc.round,
            qc.epoch,
            qc.seq_num,
            qc.participated,
            qc.validator_index,
            qc.participation_rate,
            COALESCE(vr.validator_name, 'unknown') as validator_name,
            COALESCE(vr.provider, 'unknown') as provider,
            COALESCE(vr.location, 'unknown') as location
          FROM qc_participation qc
          LEFT JOIN validator_registry vr ON qc.validator_id = vr.validator_id
          ${qcWhereClause}
          ORDER BY qc.timestamp DESC
          LIMIT ${parseInt(limit as string)}
          OFFSET ${parseInt(offset as string)}
        `;

        const qcResult = await this.clickhouseClient.executeRawQuery(qcQuery);

        const qcEvents = qcResult;
        events.push(...qcEvents.map(e => ({
          timestamp: e.timestamp,
          event_type: 'qc_participation',
          validator_id: e.validator_id,
          round_number: parseInt(e.round),
          epoch_number: parseInt(e.epoch),
          sequence_number: parseInt(e.seq_num),
          details: {
            participated: e.participated === 1,
            validator_index: e.validator_index,
            participation_rate: parseFloat(e.participation_rate)
          },
          infrastructure: {
            validator_name: e.validator_name,
            provider: e.provider,
            location: e.location
          }
        })));
      }

      // Sort events by timestamp
      events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      
      res.json({
        events: events.slice(0, parseInt(limit as string)),
        metadata: {
          searchQuery: searchQuery || null,
          filters: {
            eventType: eventType || null,
            requestedEventTypes: requestedEventTypes.length > 0 ? requestedEventTypes : null,
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

      // Get block proposal statistics
      const blockStatsQuery = `
        SELECT 
          COUNT(*) as total_block_events,
          COUNT(DISTINCT validator_id) as active_validators_blocks,
          COUNT(DISTINCT round) as unique_rounds_blocks,
          COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_block_events,
          COUNT(CASE WHEN status = 'skipped' THEN 1 END) as failed_block_events
        FROM block_proposals
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
      `;

      // Get QC participation statistics
      const qcStatsQuery = `
        SELECT 
          COUNT(*) as total_qc_events,
          COUNT(DISTINCT validator_id) as active_validators_qc,
          COUNT(DISTINCT round) as unique_rounds_qc,
          COUNT(CASE WHEN participated = 1 THEN 1 END) as successful_qc_events,
          COUNT(CASE WHEN participated = 0 THEN 1 END) as failed_qc_events,
          AVG(participation_rate) as avg_network_participation_rate
        FROM qc_participation
        WHERE timestamp >= now() - INTERVAL ${intervalClause}
      `;

      const [blockResult, qcResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(blockStatsQuery),
        this.clickhouseClient.executeRawQuery(qcStatsQuery)
      ]);

      const [blockStats] = blockResult;
      const [qcStats] = qcResult;

      const totalEvents = (parseInt(blockStats?.total_block_events || 0)) + (parseInt(qcStats?.total_qc_events || 0));
      const totalSuccessful = (parseInt(blockStats?.successful_block_events || 0)) + (parseInt(qcStats?.successful_qc_events || 0));
      const totalFailed = (parseInt(blockStats?.failed_block_events || 0)) + (parseInt(qcStats?.failed_qc_events || 0));

      const statistics = {
        total_events: totalEvents,
        unique_event_types: 3, // block_proposal, block_skipped, qc_participation
        active_validators: Math.max(parseInt(blockStats?.active_validators_blocks || 0), parseInt(qcStats?.active_validators_qc || 0)),
        unique_rounds: Math.max(parseInt(blockStats?.unique_rounds_blocks || 0), parseInt(qcStats?.unique_rounds_qc || 0)),
        avg_processing_delay: 0, // Not available in new schema
        min_processing_delay: 0, // Not available in new schema
        max_processing_delay: 0, // Not available in new schema
        successful_events: totalSuccessful,
        failed_events: totalFailed,
        success_rate: totalEvents > 0 ? (totalSuccessful / totalEvents) * 100 : 0,
        block_proposal_stats: {
          total_proposals: parseInt(blockStats?.total_block_events || 0),
          successful_proposals: parseInt(blockStats?.successful_block_events || 0),
          skipped_proposals: parseInt(blockStats?.failed_block_events || 0),
          proposal_success_rate: parseInt(blockStats?.total_block_events || 0) > 0 ? 
            (parseInt(blockStats?.successful_block_events || 0) / parseInt(blockStats?.total_block_events || 0)) * 100 : 0
        },
        qc_participation_stats: {
          total_participations: parseInt(qcStats?.total_qc_events || 0),
          successful_participations: parseInt(qcStats?.successful_qc_events || 0),
          missed_participations: parseInt(qcStats?.failed_qc_events || 0),
          avg_network_participation_rate: parseFloat(qcStats?.avg_network_participation_rate || 0)
        }
      };
      
      res.json({
        statistics,
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