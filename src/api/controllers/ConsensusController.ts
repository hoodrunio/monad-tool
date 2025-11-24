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
      // First check if we have any round data
      const latestRoundQuery = `
        SELECT epoch, round
        FROM bft_round_state
        ORDER BY epoch DESC, round DESC
        LIMIT 1
      `;

      const latestRound = await this.clickhouseClient.executeRawQuery(latestRoundQuery);

      if (!latestRound || latestRound.length === 0) {
        res.json({
          success: true,
          data: {
            votes: [],
            count: 0
          },
          message: 'No consensus round data available'
        });
        return;
      }

      const { epoch, round } = latestRound[0];

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
        WHERE v.epoch = ${epoch} AND v.round = ${round}
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
      // First check if we have any round data
      const latestRoundQuery = `
        SELECT epoch, round
        FROM bft_round_state
        ORDER BY epoch DESC, round DESC
        LIMIT 1
      `;

      const latestRound = await this.clickhouseClient.executeRawQuery(latestRoundQuery);

      if (!latestRound || latestRound.length === 0) {
        res.json({
          success: true,
          data: {
            missing: [],
            count: 0
          },
          message: 'No consensus round data available'
        });
        return;
      }

      const { epoch, round } = latestRound[0];

      const query = `
        SELECT
          v.validator_id,
          v.validator_name,
          v.keybase_id,
          v.provider,
          v.location,
          v.stake,
          v.real_time_stake_wei
        FROM validator_registry_latest FINAL v
        WHERE v.is_staking_active = 1
          AND v.validator_id NOT IN (
            SELECT author
            FROM bft_votes
            WHERE epoch = ${epoch} AND round = ${round}
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
  async getSummary(_req: Request, res: Response): Promise<void> {
    try {
      // First check if we have any round data
      const latestRoundQuery = `
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
      `;

      const latestRound = await this.clickhouseClient.executeRawQuery(latestRoundQuery);

      if (!latestRound || latestRound.length === 0) {
        res.json({
          success: true,
          data: null,
          message: 'No consensus data available'
        });
        return;
      }

      const latest = latestRound[0];

      const query = `
        WITH vote_stats AS (
          SELECT
            COUNT(DISTINCT author) AS signed_count
          FROM bft_votes
          WHERE epoch = ${latest.epoch} AND round = ${latest.round}
        ),
        validator_stats AS (
          SELECT
            COUNT() AS total_validators,
            COUNT(CASE WHEN is_staking_active = 1 THEN 1 END) AS active_validators
          FROM validator_registry_latest FINAL
        )
        SELECT
          ${latest.epoch} AS epoch,
          ${latest.round} AS round,
          ${latest.stake_ratio} AS stake_ratio,
          '${latest.current_stake}' AS current_stake,
          '${latest.total_stake}' AS total_stake,
          '${latest.ts}' AS last_update,
          v.signed_count,
          vs.total_validators,
          vs.active_validators,
          vs.active_validators - v.signed_count AS missing_count,
          (v.signed_count * 100.0 / vs.active_validators) AS participation_rate
        FROM vote_stats v
        CROSS JOIN validator_stats vs
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);

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

  /**
   * GET /api/consensus/quorum?history_limit=20
   * Get quorum status - shows peak stake across all rounds and whether 2/3 threshold is reached
   */
  async getQuorumStatus(req: Request, res: Response): Promise<void> {
    try {
      const historyLimit = Math.min(parseInt(req.query.history_limit as string) || 20, 100);
      const QUORUM_THRESHOLD = 66.67; // BFT consensus requires 2/3

      // Query 1: Get peak stake (highest current_stake across all rounds)
      const peakQuery = `
        SELECT
          current_stake,
          total_stake,
          epoch,
          round,
          ts,
          (toFloat64(current_stake) * 100.0 / toFloat64(total_stake)) as progress_percentage
        FROM bft_round_state
        ORDER BY current_stake DESC
        LIMIT 1
      `;

      const peakResult = await this.clickhouseClient.executeRawQuery(peakQuery);

      if (!peakResult || peakResult.length === 0) {
        res.json({
          success: true,
          data: null,
          message: 'No consensus data available'
        });
        return;
      }

      const peak = peakResult[0];

      // Query 2: Get total unique rounds tracked
      const statsQuery = `
        SELECT COUNT(DISTINCT concat(toString(epoch), '-', toString(round))) as total_rounds
        FROM bft_round_state
      `;

      const statsResult = await this.clickhouseClient.executeRawQuery(statsQuery);
      const totalRounds = statsResult[0]?.total_rounds || 0;

      // Query 3: Get recent peak history
      const historyQuery = `
        SELECT
          round,
          epoch,
          current_stake,
          total_stake,
          (toFloat64(current_stake) * 100.0 / toFloat64(total_stake)) as percentage,
          ts
        FROM bft_round_state
        ORDER BY ts DESC
        LIMIT ${historyLimit}
      `;

      const historyResult = await this.clickhouseClient.executeRawQuery(historyQuery);

      // Calculate quorum metrics
      const currentStake = BigInt(peak.current_stake);
      const totalStake = BigInt(peak.total_stake);
      const progressPercentage = parseFloat(peak.progress_percentage);
      const isQuorumReached = progressPercentage >= QUORUM_THRESHOLD;

      // Calculate remaining stake needed for quorum (2/3 of total)
      const quorumStakeNeeded = (totalStake * BigInt(6667)) / BigInt(10000); // 66.67%
      const remainingStakeNeeded = currentStake >= quorumStakeNeeded
        ? 0n
        : quorumStakeNeeded - currentStake;
      const remainingPercentage = Math.max(0, QUORUM_THRESHOLD - progressPercentage);

      res.json({
        success: true,
        data: {
          current_stake: currentStake.toString(),
          total_stake: totalStake.toString(),
          progress_percentage: Math.round(progressPercentage * 100) / 100, // 2 decimal places
          is_quorum_reached: isQuorumReached,
          quorum_threshold: QUORUM_THRESHOLD,
          remaining_stake_needed: remainingStakeNeeded.toString(),
          remaining_percentage: Math.round(remainingPercentage * 100) / 100,
          peak_epoch: peak.epoch,
          peak_round: peak.round,
          peak_timestamp: peak.ts,
          total_rounds_tracked: totalRounds,
          recent_peak_history: historyResult.map((h: any) => ({
            round: h.round,
            epoch: h.epoch,
            stake: h.current_stake,
            percentage: Math.round(parseFloat(h.percentage) * 100) / 100,
            ts: h.ts
          }))
        }
      });
    } catch (error) {
      logger.error('Failed to fetch quorum status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch quorum status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
