// Monad Validator Analytics - Refactored Validator Controller
// Focus: Separate Validator Metrics (Block Proposals + QC Participation)
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
  // VALIDATOR RANKINGS (Separate Metrics)
  // =============================================

  async getValidatorRankings(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '1h';
      const limit = parseInt(req.query.limit as string) || 50;
      const sortBy = (req.query.sortBy as string) || 'uptime_score';
      
      // Validate parameters
      if (!['1h', '24h', '7d'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1h, 24h, or 7d',
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

      if (!['uptime_score', 'block_proposal_ratio', 'qc_participation_rate'].includes(sortBy)) {
        res.status(400).json({
          error: 'Invalid sortBy parameter',
          message: 'Must be uptime_score, block_proposal_ratio, or qc_participation_rate',
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
            source: 'cache',
            formula: 'block_proposal_ratio * 0.3 + qc_participation_rate * 0.7'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Query from pre-computed rankings cache
      const rankings = await this.getValidatorRankingsFromCache(timeWindow, limit, sortBy);
      
      // Cache result for 2 minutes (rankings update frequently)
      await this.redisClient.cacheValidatorRankings(cacheKey, rankings, 120);
      
      res.json({
        data: rankings,
        metadata: {
          timeWindow,
          limit,
          sortBy,
          source: 'database',
          count: rankings.length,
          formula: 'block_proposal_ratio * 0.3 + qc_participation_rate * 0.7'
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
  // VALIDATOR DETAILS (Separate Metrics)
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

      // Get validator details from separate metrics
      const query = `
        SELECT 
          validator_id,
          
          -- Separate Metrics (24-hour averages)
          AVG(block_proposal_ratio) as avg_block_proposal_ratio,
          AVG(qc_participation_rate) as avg_qc_participation_rate,
          AVG(uptime_score) as avg_uptime_score,
          
          -- Supporting Data
          SUM(blocks_proposed) as total_blocks_proposed,
          SUM(blocks_skipped) as total_blocks_skipped,
          SUM(qc_participations) as total_qc_participations,
          SUM(total_qc_opportunities) as total_qc_opportunities,
          
          -- Infrastructure
          any(provider) as provider,
          any(location) as location,
          
          -- Activity
          MIN(hour) as first_seen_24h,
          MAX(hour) as last_activity
          
        FROM validator_metrics_hourly
        WHERE validator_id = '${validatorId}'
          AND hour >= now() - INTERVAL 24 HOUR
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
          message: `No data found for validator ${validatorId} in the last 24 hours`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      const validator = details[0];

      // Format response with separate metrics
      res.json({
        validator_id: validator.validator_id,
        metrics: {
          block_proposal_ratio: parseFloat(validator.avg_block_proposal_ratio || 0),
          qc_participation_rate: parseFloat(validator.avg_qc_participation_rate || 0),
          uptime_score: parseFloat(validator.avg_uptime_score || 0)
        },
        details: {
          total_blocks_proposed: parseInt(validator.total_blocks_proposed || 0),
          total_blocks_skipped: parseInt(validator.total_blocks_skipped || 0),
          total_qc_participations: parseInt(validator.total_qc_participations || 0),
          total_qc_opportunities: parseInt(validator.total_qc_opportunities || 0),
          block_opportunities: parseInt(validator.total_blocks_proposed || 0) + parseInt(validator.total_blocks_skipped || 0),
          qc_opportunities: parseInt(validator.total_qc_opportunities || 0)
        },
        infrastructure: {
          provider: validator.provider || 'unknown',
          location: validator.location || 'unknown'
        },
        activity: {
          first_seen_24h: validator.first_seen_24h,
          last_activity: validator.last_activity
        },
        metadata: {
          time_window: '24h',
          uptime_formula: 'block_proposal_ratio * 0.3 + qc_participation_rate * 0.7'
        },
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
  // VALIDATOR PERFORMANCE HISTORY
  // =============================================

  async getValidatorHistory(req: Request, res: Response): Promise<void> {
    try {
      const validatorId = req.params.id;
      const hours = parseInt(req.query.hours as string) || 24;
      
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
      const cacheKey = `validator_history:${validatorId}:${hours}`;
      const cached = await this.redisClient.getValidatorHistory(validatorId, hours);
      
      if (cached) {
        res.json({
          validatorId,
          history: cached,
          metadata: {
            hours,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Query hourly metrics
      const query = `
        SELECT 
          hour,
          block_proposal_ratio,
          qc_participation_rate,
          uptime_score,
          blocks_proposed,
          blocks_skipped,
          qc_participations,
          total_qc_opportunities
        FROM validator_metrics_hourly
        WHERE validator_id = '${validatorId}'
          AND hour >= now() - INTERVAL ${hours} HOUR
        ORDER BY hour
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const history = await result.json() as any[];
      
      // Cache result for 5 minutes
      await this.redisClient.cacheValidatorHistory(validatorId, hours, history, 300);
      
      res.json({
        validatorId,
        history: history.map(h => ({
          hour: h.hour,
          metrics: {
            block_proposal_ratio: parseFloat(h.block_proposal_ratio || 0),
            qc_participation_rate: parseFloat(h.qc_participation_rate || 0),
            uptime_score: parseFloat(h.uptime_score || 0)
          },
          activity: {
            blocks_proposed: parseInt(h.blocks_proposed || 0),
            blocks_skipped: parseInt(h.blocks_skipped || 0),
            qc_participations: parseInt(h.qc_participations || 0),
            qc_opportunities: parseInt(h.total_qc_opportunities || 0)
          }
        })),
        metadata: {
          hours,
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
  // VALIDATOR PERFORMANCE COMPARISON
  // =============================================

  async compareValidators(req: Request, res: Response): Promise<void> {
    try {
      const validatorIds = req.body.validator_ids;
      const timeWindow = (req.query.window as string) || '24h';
      
      if (!validatorIds || !Array.isArray(validatorIds) || validatorIds.length === 0) {
        res.status(400).json({
          error: 'Invalid validator IDs',
          message: 'Provide an array of validator IDs in request body',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (validatorIds.length > 20) {
        res.status(400).json({
          error: 'Too many validators',
          message: 'Maximum 20 validators allowed for comparison',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Build query for multiple validators
      const validatorIdList = validatorIds.map(id => `'${id}'`).join(',');
      const intervalClause = this.getIntervalClause(timeWindow);

      const query = `
        SELECT 
          validator_id,
          AVG(block_proposal_ratio) as avg_block_proposal_ratio,
          AVG(qc_participation_rate) as avg_qc_participation_rate,
          AVG(uptime_score) as avg_uptime_score,
          SUM(blocks_proposed) as total_blocks_proposed,
          SUM(blocks_skipped) as total_blocks_skipped,
          SUM(qc_participations) as total_qc_participations,
          SUM(total_qc_opportunities) as total_qc_opportunities,
          any(provider) as provider,
          any(location) as location
        FROM validator_metrics_hourly
        WHERE validator_id IN (${validatorIdList})
          AND hour >= now() - INTERVAL ${intervalClause}
        GROUP BY validator_id
        ORDER BY avg_uptime_score DESC
      `;

      const result = await this.clickhouseClient['client'].query({
        query,
        format: 'JSONEachRow'
      });

      const comparison = await result.json() as any[];
      
      res.json({
        comparison: comparison.map(v => ({
          validator_id: v.validator_id,
          metrics: {
            block_proposal_ratio: parseFloat(v.avg_block_proposal_ratio || 0),
            qc_participation_rate: parseFloat(v.avg_qc_participation_rate || 0),
            uptime_score: parseFloat(v.avg_uptime_score || 0)
          },
          totals: {
            blocks_proposed: parseInt(v.total_blocks_proposed || 0),
            blocks_skipped: parseInt(v.total_blocks_skipped || 0),
            qc_participations: parseInt(v.total_qc_participations || 0),
            qc_opportunities: parseInt(v.total_qc_opportunities || 0)
          },
          infrastructure: {
            provider: v.provider || 'unknown',
            location: v.location || 'unknown'
          }
        })),
        metadata: {
          timeWindow,
          validatorCount: comparison.length,
          requestedCount: validatorIds.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to compare validators:', error);
      res.status(500).json({
        error: 'Failed to compare validators',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // HELPER METHODS
  // =============================================

  private async getValidatorRankingsFromCache(timeWindow: string, limit: number, sortBy: string): Promise<any[]> {
    let orderByClause = 'avg_uptime_score DESC';
    
    switch (sortBy) {
      case 'block_proposal_ratio':
        orderByClause = 'avg_block_proposal_ratio DESC';
        break;
      case 'qc_participation_rate':
        orderByClause = 'avg_qc_participation_rate DESC';
        break;
      case 'uptime_score':
      default:
        orderByClause = 'avg_uptime_score DESC';
        break;
    }

    const query = `
      SELECT 
        rank,
        validator_id,
        avg_block_proposal_ratio,
        avg_qc_participation_rate,
        avg_uptime_score,
        total_block_opportunities,
        total_qc_opportunities,
        blocks_proposed,
        blocks_skipped,
        qc_participations,
        provider,
        location,
        last_activity
      FROM validator_rankings_cache
      WHERE time_window = '${timeWindow}'
      ORDER BY ${orderByClause}
      LIMIT ${limit}
    `;

    const result = await this.clickhouseClient['client'].query({
      query,
      format: 'JSONEachRow'
    });

    const rankings = await result.json() as any[];
    
    return rankings.map(r => ({
      rank: parseInt(r.rank),
      validator_id: r.validator_id,
      metrics: {
        block_proposal_ratio: parseFloat(r.avg_block_proposal_ratio || 0),
        qc_participation_rate: parseFloat(r.avg_qc_participation_rate || 0),
        uptime_score: parseFloat(r.avg_uptime_score || 0)
      },
      details: {
        total_block_opportunities: parseInt(r.total_block_opportunities || 0),
        total_qc_opportunities: parseInt(r.total_qc_opportunities || 0),
        blocks_proposed: parseInt(r.blocks_proposed || 0),
        blocks_skipped: parseInt(r.blocks_skipped || 0),
        qc_participations: parseInt(r.qc_participations || 0)
      },
      infrastructure: {
        provider: r.provider || 'unknown',
        location: r.location || 'unknown'
      },
      last_activity: r.last_activity
    }));
  }

  private getIntervalClause(timeWindow: string): string {
    switch (timeWindow) {
      case '1h':
        return '1 HOUR';
      case '24h':
        return '24 HOUR';
      case '7d':
        return '7 DAY';
      default:
        return '24 HOUR';
    }
  }
} 