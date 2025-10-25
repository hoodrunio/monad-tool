// Consensus Controller
// API endpoints for BFT consensus tracking data

import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { logger } from '../../utils/logger';

export class ConsensusController {
  constructor(private clickhouseClient: MonadClickHouseClient) {}

  /**
   * GET /api/consensus/latest
   * Get the latest round state with stake quorum information
   */
  async getLatestRound(req: Request, res: Response): Promise<void> {
    try {
      const query = `
        SELECT
          ts,
          epoch,
          round,
          current_stake,
          total_stake,
          stake_ratio
        FROM bft_round_state
        ORDER BY epoch DESC, round DESC
        LIMIT 1
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      if (!result || result.length === 0) {
        res.json({
          success: true,
          data: null,
          message: 'No consensus round data available'
        });
        return;
      }

      res.json({
        success: true,
        data: result[0]
      });
    } catch (error) {
      logger.error('Failed to fetch latest round:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch latest round data',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/consensus/latest/votes
   * Get validators who signed the latest round
   */
  async getLatestVotes(req: Request, res: Response): Promise<void> {
    try {
      const query = `
        SELECT
          v.ts,
          v.author,
          v.sig,
          v.vote_id,
          r.validator_name,
          r.keybase_id,
          r.provider,
          r.location
        FROM bft_votes v
        LEFT JOIN validator_registry_latest r ON v.author = r.validator_id
        WHERE (v.epoch, v.round) = (
          SELECT epoch, round
          FROM bft_round_state
          ORDER BY epoch DESC, round DESC
          LIMIT 1
        )
        ORDER BY v.ts ASC
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      res.json({
        success: true,
        data: {
          votes: result,
          count: result.length
        }
      });
    } catch (error) {
      logger.error('Failed to fetch latest votes:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch latest votes',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/consensus/latest/missing
   * Get validators who did NOT sign the latest round
   */
  async getLatestMissing(req: Request, res: Response): Promise<void> {
    try {
      const query = `
        WITH latest_round AS (
          SELECT epoch, round
          FROM bft_round_state
          ORDER BY epoch DESC, round DESC
          LIMIT 1
        )
        SELECT
          v.validator_id,
          v.validator_name,
          v.keybase_id,
          v.provider,
          v.location,
          v.stake,
          v.real_time_stake_wei
        FROM validator_registry_latest v
        WHERE v.is_staking_active = 1
          AND v.validator_id NOT IN (
            SELECT author
            FROM bft_votes
            WHERE (epoch, round) = (SELECT epoch, round FROM latest_round)
          )
        ORDER BY v.stake DESC
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      res.json({
        success: true,
        data: {
          missing: result,
          count: result.length
        }
      });
    } catch (error) {
      logger.error('Failed to fetch missing validators:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch missing validators',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/consensus/summary
   * Get consensus summary statistics for the latest round
   */
  async getSummary(req: Request, res: Response): Promise<void> {
    try {
      const query = `
        WITH latest_round AS (
          SELECT
            epoch,
            round,
            stake_ratio,
            current_stake,
            total_stake,
            ts
          FROM bft_round_state
          ORDER BY epoch DESC, round DESC
          LIMIT 1
        ),
        vote_stats AS (
          SELECT
            COUNT(DISTINCT v.author) AS signed_count
          FROM bft_votes v
          CROSS JOIN latest_round l
          WHERE v.epoch = l.epoch AND v.round = l.round
        ),
        validator_stats AS (
          SELECT
            COUNT() AS total_validators,
            COUNT(CASE WHEN is_staking_active = 1 THEN 1 END) AS active_validators
          FROM validator_registry_latest
        )
        SELECT
          l.epoch,
          l.round,
          l.stake_ratio,
          l.current_stake,
          l.total_stake,
          l.ts AS last_update,
          v.signed_count,
          vs.total_validators,
          vs.active_validators,
          vs.active_validators - v.signed_count AS missing_count,
          (v.signed_count * 100.0 / vs.active_validators) AS participation_rate
        FROM latest_round l
        CROSS JOIN vote_stats v
        CROSS JOIN validator_stats vs
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      if (!result || result.length === 0) {
        res.json({
          success: true,
          data: null,
          message: 'No consensus data available'
        });
        return;
      }

      res.json({
        success: true,
        data: result[0]
      });
    } catch (error) {
      logger.error('Failed to fetch consensus summary:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch consensus summary',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/consensus/history?limit=20
   * Get historical round states
   */
  async getHistory(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

      const query = `
        SELECT
          rs.ts,
          rs.epoch,
          rs.round,
          rs.stake_ratio,
          rs.current_stake,
          rs.total_stake,
          COUNT(DISTINCT v.author) AS signed_count
        FROM bft_round_state rs
        LEFT JOIN bft_votes v ON (rs.epoch = v.epoch AND rs.round = v.round)
        GROUP BY rs.ts, rs.epoch, rs.round, rs.stake_ratio, rs.current_stake, rs.total_stake
        ORDER BY rs.epoch DESC, rs.round DESC
        LIMIT ${limit}
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

      res.json({
        success: true,
        data: {
          rounds: result,
          count: result.length
        }
      });
    } catch (error) {
      logger.error('Failed to fetch consensus history:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch consensus history',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
