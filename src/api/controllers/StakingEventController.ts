// Staking Event Controller
// API endpoints for staking precompile event data

import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { logger } from '../../utils/logger';
import type { StakingEventIndexer } from '../../services/staking-events/StakingEventIndexer';

export class StakingEventController {
  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private stakingIndexer?: StakingEventIndexer
  ) {}

  /**
   * GET /api/staking/events
   * Get staking events with filters
   */
  async getStakingEvents(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      const eventType = req.query.type as string;
      const validatorId = req.query.validator as string;
      const delegator = req.query.delegator as string;

      let whereConditions: string[] = ['1=1'];

      if (eventType) {
        whereConditions.push(`event_type = '${eventType}'`);
      }

      if (validatorId) {
        whereConditions.push(`validator_id = '${validatorId}'`);
      }

      if (delegator) {
        whereConditions.push(`delegator = '${delegator.toLowerCase()}'`);
      }

      const query = `
        SELECT *
        FROM staking_events
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY block_timestamp DESC
        LIMIT ${limit}
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      res.json({
        events: result,
        metadata: {
          count: result.length,
          limit,
          filters: {
            eventType: eventType || null,
            validatorId: validatorId || null,
            delegator: delegator || null
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get staking events:', error);
      res.status(500).json({
        error: 'Failed to get staking events',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/staking/validators/:id/delegations
   * Get validator delegations
   */
  async getValidatorDelegations(req: Request, res: Response): Promise<void> {
    try {
      const validatorId = req.params.id;

      const query = `
        SELECT *
        FROM validator_delegations
        WHERE validator_id = '${validatorId}'
        ORDER BY last_updated_at DESC
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      const totalDelegated = result.reduce(
        (sum, d) => sum + BigInt(d.current_amount || '0'),
        BigInt(0)
      );

      res.json({
        validatorId,
        delegations: result,
        summary: {
          totalDelegators: result.length,
          totalDelegated: totalDelegated.toString(),
          totalPendingWithdrawals: result.reduce((sum, d) => sum + (d.pending_withdrawals || 0), 0)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get validator delegations:', error);
      res.status(500).json({
        error: 'Failed to get validator delegations',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/staking/delegators/:address/delegations
   * Get delegator's delegations across all validators
   */
  async getDelegatorDelegations(req: Request, res: Response): Promise<void> {
    try {
      const delegator = req.params.address.toLowerCase();

      const query = `
        SELECT
          vd.*,
          vr.validator_name,
          vr.provider,
          vr.location
        FROM validator_delegations vd
        LEFT JOIN validator_registry_latest vr ON vd.validator_id = vr.validator_id
        WHERE vd.delegator = '${delegator}'
        ORDER BY vd.current_amount DESC
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      const totalDelegated = result.reduce(
        (sum, d) => sum + BigInt(d.current_amount || '0'),
        BigInt(0)
      );

      const totalRewards = result.reduce(
        (sum, d) => sum + BigInt(d.total_rewards_claimed || '0'),
        BigInt(0)
      );

      res.json({
        delegator,
        delegations: result,
        summary: {
          totalValidators: result.length,
          totalDelegated: totalDelegated.toString(),
          totalRewardsClaimed: totalRewards.toString(),
          totalPendingWithdrawals: result.reduce((sum, d) => sum + (d.pending_withdrawals || 0), 0)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get delegator delegations:', error);
      res.status(500).json({
        error: 'Failed to get delegator delegations',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/staking/delegations/history
   * Get delegation history
   */
  async getDelegationHistory(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      const validatorId = req.query.validator as string;
      const delegator = req.query.delegator as string;
      const action = req.query.action as string;

      let whereConditions: string[] = ['1=1'];

      if (validatorId) {
        whereConditions.push(`validator_id = '${validatorId}'`);
      }

      if (delegator) {
        whereConditions.push(`delegator = '${delegator.toLowerCase()}'`);
      }

      if (action) {
        whereConditions.push(`action = '${action}'`);
      }

      const query = `
        SELECT *
        FROM delegation_history
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY block_timestamp DESC
        LIMIT ${limit}
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      res.json({
        history: result,
        metadata: {
          count: result.length,
          limit,
          filters: {
            validatorId: validatorId || null,
            delegator: delegator || null,
            action: action || null
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get delegation history:', error);
      res.status(500).json({
        error: 'Failed to get delegation history',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/staking/rewards
   * Get reward events
   */
  async getRewardEvents(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      const validatorId = req.query.validator as string;
      const delegator = req.query.delegator as string;
      const eventType = req.query.type as string;

      let whereConditions: string[] = ['1=1'];

      if (validatorId) {
        whereConditions.push(`validator_id = '${validatorId}'`);
      }

      if (delegator) {
        whereConditions.push(`delegator = '${delegator.toLowerCase()}'`);
      }

      if (eventType) {
        whereConditions.push(`event_type = '${eventType}'`);
      }

      const query = `
        SELECT *
        FROM reward_events
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY block_timestamp DESC
        LIMIT ${limit}
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      const totalRewards = result
        .filter(r => r.event_type === 'claim')
        .reduce((sum, r) => sum + BigInt(r.amount || '0'), BigInt(0));

      res.json({
        rewards: result,
        summary: {
          totalRewardsClaimed: totalRewards.toString(),
          eventCount: result.length
        },
        metadata: {
          count: result.length,
          limit,
          filters: {
            validatorId: validatorId || null,
            delegator: delegator || null,
            eventType: eventType || null
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get reward events:', error);
      res.status(500).json({
        error: 'Failed to get reward events',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/staking/stats
   * Get staking statistics
   */
  async getStakingStats(req: Request, res: Response): Promise<void> {
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

      const statsQuery = `
        SELECT
          COUNT(*) as total_events,
          COUNT(DISTINCT validator_id) as unique_validators,
          COUNT(DISTINCT delegator) as unique_delegators,
          COUNT(CASE WHEN event_type = 'Delegate' THEN 1 END) as delegate_events,
          COUNT(CASE WHEN event_type = 'Undelegate' THEN 1 END) as undelegate_events,
          COUNT(CASE WHEN event_type = 'Withdraw' THEN 1 END) as withdraw_events,
          COUNT(CASE WHEN event_type = 'ClaimRewards' THEN 1 END) as claim_events
        FROM staking_events
        WHERE block_timestamp >= now() - INTERVAL ${intervalClause}
      `;

      const result = await this.clickhouseClient.executeRawQuery(statsQuery);
      const stats = result[0] || {};

      res.json({
        statistics: {
          totalEvents: parseInt(stats.total_events || '0'),
          uniqueValidators: parseInt(stats.unique_validators || '0'),
          uniqueDelegators: parseInt(stats.unique_delegators || '0'),
          eventBreakdown: {
            delegate: parseInt(stats.delegate_events || '0'),
            undelegate: parseInt(stats.undelegate_events || '0'),
            withdraw: parseInt(stats.withdraw_events || '0'),
            claimRewards: parseInt(stats.claim_events || '0')
          }
        },
        metadata: {
          timeWindow
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get staking stats:', error);
      res.status(500).json({
        error: 'Failed to get staking stats',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * GET /api/staking/indexer/status
   * Get indexer status and metrics
   */
  async getIndexerStatus(req: Request, res: Response): Promise<void> {
    try {
      if (!this.stakingIndexer) {
        res.status(503).json({
          error: 'Indexer not available',
          message: 'Staking event indexer is not initialized',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const metrics = this.stakingIndexer.getMetrics();
      const isRunning = this.stakingIndexer.isIndexerRunning();

      res.json({
        status: isRunning ? 'running' : 'stopped',
        metrics,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get indexer status:', error);
      res.status(500).json({
        error: 'Failed to get indexer status',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }
}
