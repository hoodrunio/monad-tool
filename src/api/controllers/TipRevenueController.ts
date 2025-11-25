/**
 * Monad Validator Analytics - Tip Revenue Controller
 * API endpoints for validator tip/priority fee revenue tracking
 */
import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { TipRevenueSyncService } from '../../services/tip-revenue';
import { logger } from '../../utils/logger';
import {
  NetworkTipSummary,
  TipRevenueRankingEntry,
  TipRevenueTrendPoint,
  TipRevenueHistoryEntry
} from '../../services/tip-revenue/types';

type TimeWindow = '1h' | '24h' | '7d' | '30d';

const TIME_WINDOW_INTERVALS: Record<TimeWindow, string> = {
  '1h': '1 HOUR',
  '24h': '24 HOUR',
  '7d': '7 DAY',
  '30d': '30 DAY'
};

/**
 * Format wei values from scientific notation to integer string
 * Handles large numbers that exceed JavaScript's safe integer limit
 */
const formatWei = (value: string | number): string => {
  if (!value || value === '0') return '0';
  const num = parseFloat(String(value));
  if (isNaN(num)) return '0';
  return BigInt(Math.floor(num)).toString();
};

export class TipRevenueController {
  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient,
    private tipRevenueSyncService?: TipRevenueSyncService
  ) {}

  /**
   * Set TipRevenueSyncService after initialization
   */
  setTipRevenueSyncService(service: TipRevenueSyncService | null): void {
    this.tipRevenueSyncService = service || undefined;
    logger.info('TipRevenueSyncService updated in TipRevenueController');
  }

  // =============================================
  // VALIDATOR TIP REVENUE ENDPOINTS
  // =============================================

  /**
   * GET /api/validators/:id/tip-revenue
   * Get tip revenue for a specific validator
   */
  async getValidatorTipRevenue(req: Request, res: Response): Promise<void> {
    try {
      const { id: validatorId } = req.params;
      const window = (req.query.window as TimeWindow) || '24h';

      if (!validatorId) {
        res.status(400).json({
          error: 'Validator ID is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Check cache first
      const cached = await this.redisClient.getValidatorTipRevenue(validatorId, window);
      if (cached) {
        res.json(cached);
        return;
      }

      const interval = TIME_WINDOW_INTERVALS[window] || '24 HOUR';

      // Query tip revenue data from hourly aggregated table (validator_id resolved during aggregation)
      // Using FINAL to ensure ReplacingMergeTree deduplication is applied
      // Using floor() to avoid UInt64 overflow for wei values
      const query = `
        SELECT
          validator_id,
          toString(floor(sum(toFloat64(total_tip_wei)))) AS sum_tip_wei,
          sum(total_tip_mon) AS sum_tip_mon,
          sum(blocks_proposed) AS sum_blocks,
          sum(total_transactions) AS sum_transactions,
          toString(floor(sum(toFloat64(total_tip_wei)) / greatest(sum(blocks_proposed), 1))) AS avg_tip_block_wei,
          sum(total_tip_mon) / greatest(sum(blocks_proposed), 1) AS avg_tip_block_mon,
          toString(floor(sum(toFloat64(total_tip_wei)) / greatest(sum(total_transactions), 1))) AS avg_tip_tx_wei,
          sum(total_tip_mon) / greatest(sum(total_transactions), 1) AS avg_tip_tx_mon,
          max(hour) AS last_updated
        FROM tip_revenue_hourly FINAL
        WHERE validator_id = '${validatorId}'
          AND hour >= now() - INTERVAL ${interval}
        GROUP BY validator_id
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      // Get cumulative totals (using FINAL for ReplacingMergeTree deduplication)
      const cumulativeQuery = `
        SELECT
          total_tip_wei,
          total_tip_mon,
          total_blocks_proposed,
          total_transactions
        FROM tip_revenue_cumulative FINAL
        WHERE validator_id = '${validatorId}'
        LIMIT 1
      `;

      const cumulativeResult = await this.clickhouseClient.executeRawQuery(cumulativeQuery);

      // Get rank from hourly table - use subquery for aggregation (using FINAL)
      const rankQuery = `
        SELECT rank FROM (
          SELECT
            validator_id,
            ROW_NUMBER() OVER (ORDER BY tip_sum DESC) AS rank
          FROM (
            SELECT validator_id, sum(total_tip_mon) AS tip_sum
            FROM tip_revenue_hourly FINAL
            WHERE hour >= now() - INTERVAL ${interval}
              AND validator_id != ''
            GROUP BY validator_id
          )
        )
        WHERE validator_id = '${validatorId}'
      `;

      const rankResult = await this.clickhouseClient.executeRawQuery(rankQuery);

      // Get validator name from registry
      const validatorNameQuery = `
        SELECT validator_name
        FROM validator_registry_latest
        WHERE validator_id = '${validatorId}'
        LIMIT 1
      `;

      const validatorNameResult = await this.clickhouseClient.executeRawQuery(validatorNameQuery);

      const tipData = result[0] || {
        sum_tip_wei: '0',
        sum_tip_mon: 0,
        sum_blocks: 0,
        sum_transactions: 0,
        avg_tip_block_wei: '0',
        avg_tip_block_mon: 0,
        avg_tip_tx_wei: '0',
        avg_tip_tx_mon: 0,
        last_updated: null
      };

      const response = {
        validator_id: validatorId,
        validator_name: validatorNameResult[0]?.validator_name || 'unknown',
        tip_revenue: {
          total_wei: formatWei(tipData.sum_tip_wei),
          total_mon: parseFloat(tipData.sum_tip_mon || 0).toFixed(6),
          blocks_proposed: parseInt(tipData.sum_blocks || 0),
          total_transactions: parseInt(tipData.sum_transactions || 0),
          avg_tip_per_block_mon: parseFloat(tipData.avg_tip_block_mon || 0).toFixed(8),
          avg_tip_per_tx_mon: parseFloat(tipData.avg_tip_tx_mon || 0).toFixed(10)
        },
        cumulative: cumulativeResult[0] ? {
          total_wei: formatWei(cumulativeResult[0].total_tip_wei),
          total_mon: parseFloat(cumulativeResult[0].total_tip_mon || 0).toFixed(6),
          total_blocks: parseInt(cumulativeResult[0].total_blocks_proposed || 0)
        } : null,
        rank: rankResult[0]?.rank || null,
        metadata: {
          time_window: window,
          last_updated: tipData.last_updated || new Date().toISOString()
        }
      };

      // Cache the result
      await this.redisClient.cacheValidatorTipRevenue(validatorId, window, response);

      res.json(response);
    } catch (error) {
      logger.error('Failed to get validator tip revenue:', error);
      res.status(500).json({
        error: 'Failed to get validator tip revenue',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/validators/:id/tip-revenue/history
   * Get tip revenue history for a specific validator
   */
  async getValidatorTipHistory(req: Request, res: Response): Promise<void> {
    try {
      const { id: validatorId } = req.params;
      const hours = Math.min(parseInt(req.query.hours as string) || 24, 168);
      const granularity = (req.query.granularity as string) || 'hourly';

      if (!validatorId) {
        res.status(400).json({
          error: 'Validator ID is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Check cache first
      const cached = await this.redisClient.getValidatorTipHistory(validatorId, hours);
      if (cached) {
        res.json({
          validator_id: validatorId,
          history: cached,
          metadata: {
            hours,
            granularity,
            data_points: cached.length
          }
        });
        return;
      }

      let query: string;

      // Using FINAL for ReplacingMergeTree deduplication
      // Using floor() to avoid UInt64 overflow for wei values
      if (granularity === 'daily') {
        query = `
          SELECT
            toStartOfDay(hour) AS period,
            toString(floor(sum(toFloat64(total_tip_wei)))) AS sum_tip_wei,
            sum(total_tip_mon) AS sum_tip_mon,
            sum(blocks_proposed) AS sum_blocks,
            sum(total_transactions) AS sum_transactions,
            sum(total_tip_mon) / greatest(sum(blocks_proposed), 1) AS avg_tip_block_mon
          FROM tip_revenue_hourly FINAL
          WHERE validator_id = '${validatorId}'
            AND hour >= now() - INTERVAL ${hours} HOUR
          GROUP BY period
          ORDER BY period ASC
        `;
      } else {
        query = `
          SELECT
            hour AS period,
            total_tip_wei AS sum_tip_wei,
            total_tip_mon AS sum_tip_mon,
            blocks_proposed AS sum_blocks,
            total_transactions AS sum_transactions,
            total_tip_mon / greatest(blocks_proposed, 1) AS avg_tip_block_mon
          FROM tip_revenue_hourly FINAL
          WHERE validator_id = '${validatorId}'
            AND hour >= now() - INTERVAL ${hours} HOUR
          ORDER BY period ASC
        `;
      }

      const result = await this.clickhouseClient.executeRawQuery(query);

      const history: TipRevenueHistoryEntry[] = result.map((row: any) => ({
        hour: row.period,
        totalTipMon: parseFloat(row.sum_tip_mon || 0),
        blocksProposed: parseInt(row.sum_blocks || 0),
        avgTipPerBlockMon: parseFloat(row.avg_tip_block_mon || 0),
        totalTransactions: parseInt(row.sum_transactions || 0)
      }));

      // Cache the history
      await this.redisClient.cacheValidatorTipHistory(validatorId, hours, history);

      res.json({
        validator_id: validatorId,
        history,
        metadata: {
          hours,
          granularity,
          data_points: history.length
        }
      });
    } catch (error) {
      logger.error('Failed to get validator tip history:', error);
      res.status(500).json({
        error: 'Failed to get validator tip history',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // NETWORK TIP REVENUE ENDPOINTS
  // =============================================

  /**
   * GET /api/tip-revenue/rankings
   * Get validators ranked by tip revenue
   */
  async getTipRevenueRankings(req: Request, res: Response): Promise<void> {
    try {
      const window = (req.query.window as TimeWindow) || '24h';
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const page = parseInt(req.query.page as string) || 1;
      const sortBy = (req.query.sortBy as string) || 'total_tip';
      const offset = (page - 1) * limit;

      // Check cache first
      const cacheKey = `${window}_${sortBy}_${page}_${limit}`;
      const cached = await this.redisClient.getTipRevenueRankings(cacheKey);
      if (cached && cached.length > 0) {
        res.json(cached[0]); // Unwrap from array
        return;
      }

      const interval = TIME_WINDOW_INTERVALS[window] || '24 HOUR';

      // Map sortBy to alias names used in subquery
      const orderByMap: Record<string, string> = {
        'avg_tip_per_block': 'avg_tip_block_mon',
        'blocks_proposed': 'sum_blocks',
        'total_tip': 'sum_tip_mon'
      };
      const orderByField = orderByMap[sortBy] || 'sum_tip_mon';

      // Using FINAL for ReplacingMergeTree deduplication
      // Using floor() to avoid UInt64 overflow for wei values
      const query = `
        SELECT
          ROW_NUMBER() OVER (ORDER BY ${orderByField} DESC) AS rank,
          validator_id,
          validator_name,
          provider,
          location,
          sum_tip_wei,
          sum_tip_mon,
          sum_blocks,
          sum_transactions,
          avg_tip_block_mon
        FROM (
          SELECT
            t.validator_id AS validator_id,
            v.validator_name AS validator_name,
            v.provider AS provider,
            v.location AS location,
            toString(floor(sum(toFloat64(t.total_tip_wei)))) AS sum_tip_wei,
            sum(t.total_tip_mon) AS sum_tip_mon,
            sum(t.blocks_proposed) AS sum_blocks,
            sum(t.total_transactions) AS sum_transactions,
            sum(t.total_tip_mon) / greatest(sum(t.blocks_proposed), 1) AS avg_tip_block_mon
          FROM tip_revenue_hourly FINAL t
          LEFT JOIN validator_registry_latest v ON t.validator_id = v.validator_id
          WHERE t.hour >= now() - INTERVAL ${interval}
            AND t.validator_id != ''
          GROUP BY t.validator_id, v.validator_name, v.provider, v.location
        )
        ORDER BY ${orderByField} DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      // Get total count from hourly table (using FINAL)
      const countQuery = `
        SELECT count(DISTINCT validator_id) AS total
        FROM tip_revenue_hourly FINAL
        WHERE hour >= now() - INTERVAL ${interval}
          AND validator_id != ''
      `;

      const countResult = await this.clickhouseClient.executeRawQuery(countQuery);
      const totalCount = parseInt(countResult[0]?.total || 0);

      const rankings: TipRevenueRankingEntry[] = result.map((row: any) => ({
        rank: parseInt(row.rank),
        validatorId: row.validator_id,
        validatorName: row.validator_name || 'unknown',
        totalTipMon: parseFloat(row.sum_tip_mon || 0).toFixed(6),
        blocksProposed: parseInt(row.sum_blocks || 0),
        avgTipPerBlockMon: parseFloat(row.avg_tip_block_mon || 0).toFixed(8),
        totalTransactions: parseInt(row.sum_transactions || 0),
        infrastructure: {
          provider: row.provider || 'unknown',
          location: row.location || 'unknown'
        }
      }));

      const response = {
        rankings,
        pagination: {
          current_page: page,
          total_pages: Math.ceil(totalCount / limit),
          total_count: totalCount,
          per_page: limit
        },
        metadata: {
          time_window: window,
          sort_by: sortBy,
          timestamp: new Date().toISOString()
        }
      };

      // Cache the result (cache expects any[] so we store as array wrapper)
      await this.redisClient.cacheTipRevenueRankings(cacheKey, [response]);

      res.json(response);
    } catch (error) {
      logger.error('Failed to get tip revenue rankings:', error);
      res.status(500).json({
        error: 'Failed to get tip revenue rankings',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/tip-revenue/network/summary
   * Get network-wide tip revenue summary
   */
  async getNetworkTipSummary(_req: Request, res: Response): Promise<void> {
    try {
      // Check cache first
      const cached = await this.redisClient.getTipRevenueSummary();
      if (cached) {
        res.json(cached);
        return;
      }

      // Using FINAL for ReplacingMergeTree deduplication
      // Using floor() to avoid UInt64 overflow for wei values
      const query = `
        SELECT
          toString(floor(sum(toFloat64(total_tip_wei)))) AS sum_tips_wei,
          sum(total_tip_mon) AS sum_tips_mon,
          sum(blocks_proposed) AS sum_blocks,
          sum(total_transactions) AS sum_transactions,
          sum(total_tip_mon) / greatest(sum(blocks_proposed), 1) AS avg_tip_block_mon
        FROM tip_revenue_hourly FINAL
        WHERE hour >= now() - INTERVAL 24 HOUR
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      // Get top validator from hourly table (using FINAL)
      const topValidatorQuery = `
        SELECT
          t.validator_id AS validator_id,
          v.validator_name AS validator_name,
          sum(t.total_tip_mon) AS sum_tip_mon
        FROM tip_revenue_hourly FINAL t
        LEFT JOIN validator_registry_latest v ON t.validator_id = v.validator_id
        WHERE t.hour >= now() - INTERVAL 24 HOUR
          AND t.validator_id != ''
        GROUP BY t.validator_id, v.validator_name
        ORDER BY sum_tip_mon DESC
        LIMIT 1
      `;

      const topValidatorResult = await this.clickhouseClient.executeRawQuery(topValidatorQuery);

      const summary = result[0] || {
        sum_tips_mon: 0,
        avg_tip_block_mon: 0,
        sum_blocks: 0,
        sum_transactions: 0
      };

      const response: NetworkTipSummary = {
        totalTips24hMon: parseFloat(summary.sum_tips_mon || 0).toFixed(4),
        avgTipPerBlockMon: parseFloat(summary.avg_tip_block_mon || 0).toFixed(8),
        totalBlocks24h: parseInt(summary.sum_blocks || 0),
        totalTransactions24h: parseInt(summary.sum_transactions || 0),
        topValidator: topValidatorResult[0] ? {
          validatorId: topValidatorResult[0].validator_id,
          validatorName: topValidatorResult[0].validator_name || 'unknown',
          totalTipMon: parseFloat(topValidatorResult[0].sum_tip_mon || 0).toFixed(6)
        } : null,
        timestamp: new Date()
      };

      // Cache the result
      await this.redisClient.cacheTipRevenueSummary(response);

      res.json(response);
    } catch (error) {
      logger.error('Failed to get network tip summary:', error);
      res.status(500).json({
        error: 'Failed to get network tip summary',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/tip-revenue/trends
   * Get tip revenue trends over time
   */
  async getTipRevenueTrends(req: Request, res: Response): Promise<void> {
    try {
      const hours = Math.min(parseInt(req.query.hours as string) || 24, 168);

      // Check cache first
      const cached = await this.redisClient.getTipRevenueTrends(hours);
      if (cached) {
        res.json({
          trends: cached,
          metadata: {
            hours,
            data_points: cached.length,
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      // Using FINAL for ReplacingMergeTree deduplication
      const query = `
        SELECT
          hour,
          sum(total_tip_mon) AS sum_tip_mon,
          sum(blocks_proposed) AS sum_blocks,
          sum(total_tip_mon) / greatest(sum(blocks_proposed), 1) AS avg_tip_block_mon,
          uniq(validator_id) AS active_validators
        FROM tip_revenue_hourly FINAL
        WHERE hour >= now() - INTERVAL ${hours} HOUR
        GROUP BY hour
        ORDER BY hour ASC
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      const trends: TipRevenueTrendPoint[] = result.map((row: any) => ({
        hour: row.hour,
        totalTipMon: parseFloat(row.sum_tip_mon || 0),
        totalBlocks: parseInt(row.sum_blocks || 0),
        avgTipPerBlockMon: parseFloat(row.avg_tip_block_mon || 0),
        activeValidators: parseInt(row.active_validators || 0)
      }));

      // Cache the result
      await this.redisClient.cacheTipRevenueTrends(trends, hours);

      res.json({
        trends,
        metadata: {
          hours,
          data_points: trends.length,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Failed to get tip revenue trends:', error);
      res.status(500).json({
        error: 'Failed to get tip revenue trends',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // SYNC SERVICE STATUS ENDPOINTS
  // =============================================

  /**
   * GET /api/tip-revenue/sync/status
   * Get sync service status
   */
  async getSyncStatus(_req: Request, res: Response): Promise<void> {
    try {
      if (!this.tipRevenueSyncService) {
        res.status(503).json({
          error: 'Tip revenue sync service not available',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const status = await this.tipRevenueSyncService.getDetailedStatus();

      res.json({
        ...status,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get sync status:', error);
      res.status(500).json({
        error: 'Failed to get sync status',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * POST /api/tip-revenue/sync/force
   * Force a sync
   */
  async forceSyncUpdate(_req: Request, res: Response): Promise<void> {
    try {
      if (!this.tipRevenueSyncService) {
        res.status(503).json({
          error: 'Tip revenue sync service not available',
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.info('Force tip revenue sync requested');
      await this.tipRevenueSyncService.forceSync();

      res.json({
        message: 'Tip revenue sync completed successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to force sync:', error);
      res.status(500).json({
        error: 'Failed to force sync',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }
}
