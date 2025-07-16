// Monad Validator Analytics - Transaction Analytics Controller
// Focus: Comprehensive transaction processing analytics for validators
import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

interface TransactionMetrics {
  validatorId: string;
  totalProposals: number;
  totalTransactions: number;
  avgTransactionsPerBlock: number;
  maxTransactionsInBlock: number;
  transactionThroughput: number;
  blockUtilizationRate: number;
  transactionEfficiency: number;
}

interface NetworkTransactionSummary {
  totalTransactions: number;
  totalBlocks: number;
  avgTransactionsPerBlock: number;
  peakTransactionRate: number;
  activeValidators: number;
  networkThroughput: number;
}

interface TransactionTrend {
  timestamp: string;
  totalTransactions: number;
  blockCount: number;
  avgTransactionsPerBlock: number;
  validatorCount: number;
}

export class TransactionAnalyticsController {
  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {}

  // =============================================
  // VALIDATOR TRANSACTION ANALYTICS
  // =============================================

  /**
   * Get comprehensive transaction metrics for a specific validator
   * GET /api/transaction-analytics/validator/:id
   */
  async getValidatorTransactionMetrics(req: Request, res: Response): Promise<void> {
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

      // Validate time window
      if (!['1h', '6h', '24h', '7d', '30d'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1h, 6h, 24h, 7d, or 30d',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Try cache first
      const cacheKey = `validator_tx_metrics:${validatorId}:${timeWindow}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          data: JSON.parse(cached),
          metadata: {
            validatorId,
            timeWindow,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      const intervalClause = this.getIntervalClause(timeWindow);
      
      // Get validator transaction metrics
      const metricsQuery = `
        SELECT 
          bp.validator_id,
          COUNT(*) as total_proposals,
          COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) as successful_proposals,
          SUM(bp.num_tx) as total_transactions,
          AVG(bp.num_tx) as avg_transactions_per_block,
          MAX(bp.num_tx) as max_transactions_in_block,
          COUNT(CASE WHEN bp.num_tx > 0 THEN 1 END) as blocks_with_transactions,
          (COUNT(CASE WHEN bp.num_tx > 0 THEN 1 END) * 100.0 / COUNT(*)) as block_utilization_rate,
          (SUM(bp.num_tx) / COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END)) as transaction_efficiency,
          MIN(bp.timestamp) as first_activity,
          MAX(bp.timestamp) as last_activity,
          COALESCE(vr.validator_name, 'unknown') as validator_name,
          COALESCE(vr.provider, 'unknown') as provider,
          COALESCE(vr.location, 'unknown') as location,
          COALESCE(vr.stake, 0) as stake
        FROM block_proposals bp
        LEFT JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
        WHERE bp.validator_id = '${validatorId}'
          AND bp.timestamp >= now() - INTERVAL ${intervalClause}
        GROUP BY bp.validator_id, vr.validator_name, vr.provider, vr.location, vr.stake
      `;

      const result = await this.clickhouseClient.executeRawQuery(metricsQuery);
      
      if (result.length === 0) {
        res.status(404).json({
          error: 'Validator not found',
          message: `No data found for validator ${validatorId} in the specified time window`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      const metrics = result[0];
      
      // Calculate transaction throughput (transactions per hour)
      const timeWindowHours = this.getTimeWindowHours(timeWindow);
      const transactionThroughput = parseFloat(metrics.total_transactions) / timeWindowHours;

      const responseData = {
        validatorId,
        validatorName: metrics.validator_name,
        infrastructure: {
          provider: metrics.provider,
          location: metrics.location,
          stake: parseInt(metrics.stake)
        },
        transactionMetrics: {
          totalProposals: parseInt(metrics.total_proposals),
          successfulProposals: parseInt(metrics.successful_proposals),
          totalTransactions: parseInt(metrics.total_transactions),
          avgTransactionsPerBlock: parseFloat(metrics.avg_transactions_per_block || 0),
          maxTransactionsInBlock: parseInt(metrics.max_transactions_in_block || 0),
          blocksWithTransactions: parseInt(metrics.blocks_with_transactions),
          blockUtilizationRate: parseFloat(metrics.block_utilization_rate || 0),
          transactionEfficiency: parseFloat(metrics.transaction_efficiency || 0),
          transactionThroughput: transactionThroughput
        },
        timeWindow: {
          window: timeWindow,
          hours: timeWindowHours,
          firstActivity: metrics.first_activity,
          lastActivity: metrics.last_activity
        }
      };

      // Cache for appropriate duration
      const cacheDuration = this.getCacheDuration(timeWindow);
      await this.redisClient['client'].setex(cacheKey, cacheDuration, JSON.stringify(responseData));
      
      res.json({
        data: responseData,
        metadata: {
          timeWindow,
          source: 'database'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get validator transaction metrics:', error);
      res.status(500).json({
        error: 'Failed to get validator transaction metrics',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get validator transaction trends over time
   * GET /api/transaction-analytics/validator/:id/trends
   */
  async getValidatorTransactionTrends(req: Request, res: Response): Promise<void> {
    try {
      const validatorId = req.params.id;
      const timeWindow = (req.query.window as string) || '24h';
      const granularity = (req.query.granularity as string) || 'hour';
      
      if (!validatorId) {
        res.status(400).json({
          error: 'Missing validator ID',
          message: 'Validator ID is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Validate parameters
      if (!['1h', '6h', '24h', '7d', '30d'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1h, 6h, 24h, 7d, or 30d',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (!['minute', 'hour', 'day'].includes(granularity)) {
        res.status(400).json({
          error: 'Invalid granularity',
          message: 'Must be minute, hour, or day',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const cacheKey = `validator_tx_trends:${validatorId}:${timeWindow}:${granularity}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          data: JSON.parse(cached),
          metadata: {
            validatorId,
            timeWindow,
            granularity,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      const intervalClause = this.getIntervalClause(timeWindow);
      const timeGrouping = this.getTimeGrouping(granularity);
      
      const trendsQuery = `
        SELECT 
          ${timeGrouping} as time_bucket,
          COUNT(*) as total_proposals,
          COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_proposals,
          SUM(num_tx) as total_transactions,
          AVG(num_tx) as avg_transactions_per_block,
          MAX(num_tx) as max_transactions_in_block,
          COUNT(CASE WHEN num_tx > 0 THEN 1 END) as blocks_with_transactions
        FROM block_proposals
        WHERE validator_id = '${validatorId}'
          AND timestamp >= now() - INTERVAL ${intervalClause}
        GROUP BY time_bucket
        ORDER BY time_bucket
      `;

      const result = await this.clickhouseClient.executeRawQuery(trendsQuery);
      
      const trends = result.map(row => ({
        timestamp: row.time_bucket,
        totalProposals: parseInt(row.total_proposals),
        successfulProposals: parseInt(row.successful_proposals),
        totalTransactions: parseInt(row.total_transactions),
        avgTransactionsPerBlock: parseFloat(row.avg_transactions_per_block || 0),
        maxTransactionsInBlock: parseInt(row.max_transactions_in_block || 0),
        blocksWithTransactions: parseInt(row.blocks_with_transactions),
        blockUtilizationRate: (parseInt(row.blocks_with_transactions) / parseInt(row.total_proposals)) * 100
      }));

      const responseData = {
        validatorId,
        trends,
        summary: {
          totalDataPoints: trends.length,
          timeWindow,
          granularity
        }
      };

      const cacheDuration = this.getCacheDuration(timeWindow);
      await this.redisClient['client'].setex(cacheKey, cacheDuration, JSON.stringify(responseData));
      
      res.json({
        data: responseData,
        metadata: {
          timeWindow,
          granularity,
          source: 'database'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get validator transaction trends:', error);
      res.status(500).json({
        error: 'Failed to get validator transaction trends',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // NETWORK TRANSACTION ANALYTICS
  // =============================================

  /**
   * Get network-wide transaction summary
   * GET /api/transaction-analytics/network/summary
   */
  async getNetworkTransactionSummary(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      
      if (!['1h', '6h', '24h', '7d', '30d'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1h, 6h, 24h, 7d, or 30d',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const cacheKey = `network_tx_summary:${timeWindow}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          data: JSON.parse(cached),
          metadata: {
            timeWindow,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      const intervalClause = this.getIntervalClause(timeWindow);
      
      // Network transaction summary
      const summaryQuery = `
        SELECT 
          COUNT(*) as total_blocks,
          COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_blocks,
          SUM(num_tx) as total_transactions,
          AVG(num_tx) as avg_transactions_per_block,
          MAX(num_tx) as max_transactions_in_block,
          COUNT(CASE WHEN num_tx > 0 THEN 1 END) as blocks_with_transactions,
          COUNT(DISTINCT validator_id) as active_validators,
          (COUNT(CASE WHEN num_tx > 0 THEN 1 END) * 100.0 / COUNT(*)) as network_utilization_rate
        FROM block_proposals bp
        INNER JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
        WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
      `;

      // Peak transaction rate (max transactions in any hour)
      const peakQuery = `
        SELECT 
          MAX(hourly_tx) as peak_transaction_rate
        FROM (
          SELECT 
            toStartOfHour(timestamp) as hour,
            SUM(num_tx) as hourly_tx
          FROM block_proposals bp
          INNER JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
          WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
          GROUP BY hour
        )
      `;

      const [summaryResult, peakResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(summaryQuery),
        this.clickhouseClient.executeRawQuery(peakQuery)
      ]);

      if (summaryResult.length === 0) {
        res.status(404).json({
          error: 'No data found',
          message: 'No transaction data found for the specified time window',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const summary = summaryResult[0];
      const peak = peakResult[0];
      
      const timeWindowHours = this.getTimeWindowHours(timeWindow);
      const networkThroughput = parseFloat(summary.total_transactions) / timeWindowHours;

      const responseData: NetworkTransactionSummary = {
        totalTransactions: parseInt(summary.total_transactions),
        totalBlocks: parseInt(summary.total_blocks),
        avgTransactionsPerBlock: parseFloat(summary.avg_transactions_per_block || 0),
        peakTransactionRate: parseInt(peak.peak_transaction_rate || 0),
        activeValidators: parseInt(summary.active_validators),
        networkThroughput: networkThroughput
      };

      const cacheDuration = this.getCacheDuration(timeWindow);
      await this.redisClient['client'].setex(cacheKey, cacheDuration, JSON.stringify(responseData));
      
      res.json({
        data: responseData,
        metadata: {
          timeWindow,
          timeWindowHours,
          source: 'database'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get network transaction summary:', error);
      res.status(500).json({
        error: 'Failed to get network transaction summary',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get network transaction trends over time
   * GET /api/transaction-analytics/network/trends
   */
  async getNetworkTransactionTrends(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      const granularity = (req.query.granularity as string) || 'hour';
      
      if (!['1h', '6h', '24h', '7d', '30d'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1h, 6h, 24h, 7d, or 30d',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (!['minute', 'hour', 'day'].includes(granularity)) {
        res.status(400).json({
          error: 'Invalid granularity',
          message: 'Must be minute, hour, or day',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const cacheKey = `network_tx_trends:${timeWindow}:${granularity}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          data: JSON.parse(cached),
          metadata: {
            timeWindow,
            granularity,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      const intervalClause = this.getIntervalClause(timeWindow);
      const timeGrouping = this.getTimeGrouping(granularity);
      
      const trendsQuery = `
        SELECT 
          ${timeGrouping} as time_bucket,
          COUNT(*) as total_blocks,
          COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_blocks,
          SUM(num_tx) as total_transactions,
          AVG(num_tx) as avg_transactions_per_block,
          COUNT(DISTINCT validator_id) as active_validators,
          COUNT(CASE WHEN num_tx > 0 THEN 1 END) as blocks_with_transactions,
          (COUNT(CASE WHEN num_tx > 0 THEN 1 END) * 100.0 / COUNT(*)) as network_utilization_rate
        FROM block_proposals bp
        INNER JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
        WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
        GROUP BY time_bucket
        ORDER BY time_bucket
      `;

      const result = await this.clickhouseClient.executeRawQuery(trendsQuery);
      
      const trends: TransactionTrend[] = result.map(row => ({
        timestamp: row.time_bucket,
        totalTransactions: parseInt(row.total_transactions),
        blockCount: parseInt(row.total_blocks),
        avgTransactionsPerBlock: parseFloat(row.avg_transactions_per_block || 0),
        validatorCount: parseInt(row.active_validators)
      }));

      const responseData = {
        trends,
        summary: {
          totalDataPoints: trends.length,
          timeWindow,
          granularity,
          totalTransactions: trends.reduce((sum, t) => sum + t.totalTransactions, 0),
          totalBlocks: trends.reduce((sum, t) => sum + t.blockCount, 0)
        }
      };

      const cacheDuration = this.getCacheDuration(timeWindow);
      await this.redisClient['client'].setex(cacheKey, cacheDuration, JSON.stringify(responseData));
      
      res.json({
        data: responseData,
        metadata: {
          timeWindow,
          granularity,
          source: 'database'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get network transaction trends:', error);
      res.status(500).json({
        error: 'Failed to get network transaction trends',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // VALIDATOR RANKINGS BY TRANSACTION PERFORMANCE
  // =============================================

  /**
   * Get validator rankings by transaction processing performance
   * GET /api/transaction-analytics/rankings
   */
  async getValidatorTransactionRankings(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      const limit = parseInt(req.query.limit as string) || 50;
      const page = parseInt(req.query.page as string) || 1;
      const sortBy = (req.query.sortBy as string) || 'total_transactions';
      
      // Validate parameters
      if (!['1h', '6h', '24h', '7d', '30d'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1h, 6h, 24h, 7d, or 30d',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (limit > 1000 || limit < 1) {
        res.status(400).json({
          error: 'Invalid limit',
          message: 'Limit must be between 1 and 1000',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (page < 1) {
        res.status(400).json({
          error: 'Invalid page parameter',
          message: 'Page must be >= 1',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const validSortBy = [
        'total_transactions', 'avg_transactions_per_block', 'transaction_throughput',
        'block_utilization_rate', 'transaction_efficiency', 'total_proposals'
      ];
      
      if (!validSortBy.includes(sortBy)) {
        res.status(400).json({
          error: 'Invalid sortBy parameter',
          message: `Must be one of: ${validSortBy.join(', ')}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      const cacheKey = `validator_tx_rankings:${timeWindow}:${limit}:${page}:${sortBy}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          data: JSON.parse(cached),
          metadata: {
            timeWindow,
            limit,
            page,
            sortBy,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      const intervalClause = this.getIntervalClause(timeWindow);
      const offset = (page - 1) * limit;
      const timeWindowHours = this.getTimeWindowHours(timeWindow);
      
      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(DISTINCT bp.validator_id) as total_count
        FROM block_proposals bp
        INNER JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
        WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
      `;

      // Main ranking query
      const rankingQuery = `
        SELECT 
          bp.validator_id,
          COUNT(*) as total_proposals,
          COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) as successful_proposals,
          SUM(bp.num_tx) as total_transactions,
          AVG(bp.num_tx) as avg_transactions_per_block,
          MAX(bp.num_tx) as max_transactions_in_block,
          COUNT(CASE WHEN bp.num_tx > 0 THEN 1 END) as blocks_with_transactions,
          (COUNT(CASE WHEN bp.num_tx > 0 THEN 1 END) * 100.0 / COUNT(*)) as block_utilization_rate,
          (SUM(bp.num_tx) / COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END)) as transaction_efficiency,
          (SUM(bp.num_tx) / ${timeWindowHours}) as transaction_throughput,
          COALESCE(vr.validator_name, 'unknown') as validator_name,
          COALESCE(vr.provider, 'unknown') as provider,
          COALESCE(vr.location, 'unknown') as location,
          COALESCE(vr.stake, 0) as stake
        FROM block_proposals bp
        INNER JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
        WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
        GROUP BY bp.validator_id, vr.validator_name, vr.provider, vr.location, vr.stake
        ORDER BY ${this.getTransactionSortClause(sortBy)} DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const [countResult, rankingResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(countQuery),
        this.clickhouseClient.executeRawQuery(rankingQuery)
      ]);

      const totalCount = countResult[0]?.total_count || 0;
      const totalPages = Math.ceil(totalCount / limit);
      
      const rankings = rankingResult.map((row, index) => ({
        rank: offset + index + 1,
        validatorId: row.validator_id,
        validatorName: row.validator_name,
        infrastructure: {
          provider: row.provider,
          location: row.location,
          stake: parseInt(row.stake)
        },
        transactionMetrics: {
          totalProposals: parseInt(row.total_proposals),
          successfulProposals: parseInt(row.successful_proposals),
          totalTransactions: parseInt(row.total_transactions),
          avgTransactionsPerBlock: parseFloat(row.avg_transactions_per_block || 0),
          maxTransactionsInBlock: parseInt(row.max_transactions_in_block || 0),
          blocksWithTransactions: parseInt(row.blocks_with_transactions),
          blockUtilizationRate: parseFloat(row.block_utilization_rate || 0),
          transactionEfficiency: parseFloat(row.transaction_efficiency || 0),
          transactionThroughput: parseFloat(row.transaction_throughput || 0)
        }
      }));

      const responseData = {
        rankings,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount: parseInt(totalCount),
          limit,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1
        },
        summary: {
          timeWindow,
          sortBy,
          totalValidators: parseInt(totalCount)
        }
      };

      const cacheDuration = this.getCacheDuration(timeWindow);
      await this.redisClient['client'].setex(cacheKey, cacheDuration, JSON.stringify(responseData));
      
      res.json({
        data: responseData,
        metadata: {
          timeWindow,
          limit,
          page,
          sortBy,
          source: 'database'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get validator transaction rankings:', error);
      res.status(500).json({
        error: 'Failed to get validator transaction rankings',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // GEOGRAPHIC & PROVIDER TRANSACTION ANALYTICS
  // =============================================

  /**
   * Get transaction processing analytics by geographic location
   * GET /api/transaction-analytics/geographic
   */
  async getGeographicTransactionAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      
      if (!['1h', '6h', '24h', '7d', '30d'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1h, 6h, 24h, 7d, or 30d',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const cacheKey = `geographic_tx_analytics:${timeWindow}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          data: JSON.parse(cached),
          metadata: {
            timeWindow,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      const intervalClause = this.getIntervalClause(timeWindow);
      
      const geographicQuery = `
        SELECT 
          vr.location,
          COUNT(DISTINCT bp.validator_id) as validator_count,
          COUNT(*) as total_proposals,
          COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) as successful_proposals,
          SUM(bp.num_tx) as total_transactions,
          AVG(bp.num_tx) as avg_transactions_per_block,
          MAX(bp.num_tx) as max_transactions_in_block,
          COUNT(CASE WHEN bp.num_tx > 0 THEN 1 END) as blocks_with_transactions,
          (COUNT(CASE WHEN bp.num_tx > 0 THEN 1 END) * 100.0 / COUNT(*)) as block_utilization_rate,
          (SUM(bp.num_tx) / COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END)) as transaction_efficiency
        FROM block_proposals bp
        INNER JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
        WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
          AND vr.location != 'unknown' 
          AND vr.location IS NOT NULL
        GROUP BY vr.location
        HAVING COUNT(DISTINCT bp.validator_id) > 0
        ORDER BY total_transactions DESC
      `;

      const result = await this.clickhouseClient.executeRawQuery(geographicQuery);
      
      const geographicData = result.map(row => ({
        location: row.location,
        validatorCount: parseInt(row.validator_count),
        transactionMetrics: {
          totalProposals: parseInt(row.total_proposals),
          successfulProposals: parseInt(row.successful_proposals),
          totalTransactions: parseInt(row.total_transactions),
          avgTransactionsPerBlock: parseFloat(row.avg_transactions_per_block || 0),
          maxTransactionsInBlock: parseInt(row.max_transactions_in_block || 0),
          blocksWithTransactions: parseInt(row.blocks_with_transactions),
          blockUtilizationRate: parseFloat(row.block_utilization_rate || 0),
          transactionEfficiency: parseFloat(row.transaction_efficiency || 0)
        }
      }));

      const responseData = {
        geographicDistribution: geographicData,
        summary: {
          totalLocations: geographicData.length,
          totalValidators: geographicData.reduce((sum, loc) => sum + loc.validatorCount, 0),
          totalTransactions: geographicData.reduce((sum, loc) => sum + loc.transactionMetrics.totalTransactions, 0),
          timeWindow
        }
      };

      const cacheDuration = this.getCacheDuration(timeWindow);
      await this.redisClient['client'].setex(cacheKey, cacheDuration, JSON.stringify(responseData));
      
      res.json({
        data: responseData,
        metadata: {
          timeWindow,
          source: 'database'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get geographic transaction analytics:', error);
      res.status(500).json({
        error: 'Failed to get geographic transaction analytics',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get transaction processing analytics by infrastructure provider
   * GET /api/transaction-analytics/providers
   */
  async getProviderTransactionAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '24h';
      
      if (!['1h', '6h', '24h', '7d', '30d'].includes(timeWindow)) {
        res.status(400).json({
          error: 'Invalid time window',
          message: 'Must be 1h, 6h, 24h, 7d, or 30d',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const cacheKey = `provider_tx_analytics:${timeWindow}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          data: JSON.parse(cached),
          metadata: {
            timeWindow,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      const intervalClause = this.getIntervalClause(timeWindow);
      
      const providerQuery = `
        SELECT 
          vr.provider,
          COUNT(DISTINCT bp.validator_id) as validator_count,
          COUNT(*) as total_proposals,
          COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) as successful_proposals,
          SUM(bp.num_tx) as total_transactions,
          AVG(bp.num_tx) as avg_transactions_per_block,
          MAX(bp.num_tx) as max_transactions_in_block,
          COUNT(CASE WHEN bp.num_tx > 0 THEN 1 END) as blocks_with_transactions,
          (COUNT(CASE WHEN bp.num_tx > 0 THEN 1 END) * 100.0 / COUNT(*)) as block_utilization_rate,
          (SUM(bp.num_tx) / COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END)) as transaction_efficiency,
          arrayDistinct(groupArray(vr.location)) as locations
        FROM block_proposals bp
        INNER JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
        WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
          AND vr.provider != 'unknown' 
          AND vr.provider IS NOT NULL
        GROUP BY vr.provider
        HAVING COUNT(DISTINCT bp.validator_id) > 0
        ORDER BY total_transactions DESC
      `;

      const result = await this.clickhouseClient.executeRawQuery(providerQuery);
      
      const providerData = result.map(row => ({
        provider: row.provider,
        validatorCount: parseInt(row.validator_count),
        locations: Array.isArray(row.locations) ? row.locations : [row.locations],
        transactionMetrics: {
          totalProposals: parseInt(row.total_proposals),
          successfulProposals: parseInt(row.successful_proposals),
          totalTransactions: parseInt(row.total_transactions),
          avgTransactionsPerBlock: parseFloat(row.avg_transactions_per_block || 0),
          maxTransactionsInBlock: parseInt(row.max_transactions_in_block || 0),
          blocksWithTransactions: parseInt(row.blocks_with_transactions),
          blockUtilizationRate: parseFloat(row.block_utilization_rate || 0),
          transactionEfficiency: parseFloat(row.transaction_efficiency || 0)
        }
      }));

      const responseData = {
        providerDistribution: providerData,
        summary: {
          totalProviders: providerData.length,
          totalValidators: providerData.reduce((sum, provider) => sum + provider.validatorCount, 0),
          totalTransactions: providerData.reduce((sum, provider) => sum + provider.transactionMetrics.totalTransactions, 0),
          timeWindow
        }
      };

      const cacheDuration = this.getCacheDuration(timeWindow);
      await this.redisClient['client'].setex(cacheKey, cacheDuration, JSON.stringify(responseData));
      
      res.json({
        data: responseData,
        metadata: {
          timeWindow,
          source: 'database'
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get provider transaction analytics:', error);
      res.status(500).json({
        error: 'Failed to get provider transaction analytics',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // HELPER METHODS
  // =============================================

  private getIntervalClause(timeWindow: string): string {
    switch (timeWindow) {
      case '1h': return '1 HOUR';
      case '6h': return '6 HOUR';
      case '24h': return '24 HOUR';
      case '7d': return '7 DAY';
      case '30d': return '30 DAY';
      default: return '24 HOUR';
    }
  }

  private getTimeWindowHours(timeWindow: string): number {
    switch (timeWindow) {
      case '1h': return 1;
      case '6h': return 6;
      case '24h': return 24;
      case '7d': return 168; // 7 * 24
      case '30d': return 720; // 30 * 24
      default: return 24;
    }
  }

  private getTimeGrouping(granularity: string): string {
    switch (granularity) {
      case 'minute': return 'toStartOfMinute(timestamp)';
      case 'hour': return 'toStartOfHour(timestamp)';
      case 'day': return 'toStartOfDay(timestamp)';
      default: return 'toStartOfHour(timestamp)';
    }
  }

  private getTransactionSortClause(sortBy: string): string {
    switch (sortBy) {
      case 'total_transactions': return 'total_transactions';
      case 'avg_transactions_per_block': return 'avg_transactions_per_block';
      case 'transaction_throughput': return 'transaction_throughput';
      case 'block_utilization_rate': return 'block_utilization_rate';
      case 'transaction_efficiency': return 'transaction_efficiency';
      case 'total_proposals': return 'total_proposals';
      default: return 'total_transactions';
    }
  }

  private getCacheDuration(timeWindow: string): number {
    switch (timeWindow) {
      case '1h': return 60; // 1 minute cache
      case '6h': return 300; // 5 minutes cache
      case '24h': return 600; // 10 minutes cache
      case '7d': return 1800; // 30 minutes cache
      case '30d': return 3600; // 1 hour cache
      default: return 600;
    }
  }
} 