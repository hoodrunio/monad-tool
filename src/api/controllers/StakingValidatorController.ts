// Staking-aware Validator Controller
import { Request, Response } from 'express';
import { StakingPrecompileService } from '../../services/staking/StakingPrecompileService';
import { ValidatorStatusSyncService } from '../../services/staking/ValidatorStatusSyncService';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

/**
 * Enhanced Validator Controller with Staking Integration
 * 
 * Provides backward-compatible API endpoints while adding new staking-aware functionality:
 * - Active/Inactive validator classification
 * - Real-time staking data
 * - Epoch-aware queries
 * - Enhanced validator details
 */
export class StakingValidatorController {
  constructor(
    private stakingService: StakingPrecompileService,
    private syncService: ValidatorStatusSyncService,
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {}

  // =============================================
  // NEW STAKING-AWARE ENDPOINTS
  // =============================================

  /**
   * Get all validators with active/inactive classification
   * NEW ENDPOINT: /api/v2/validators
   */
  async getValidatorsV2(req: Request, res: Response): Promise<void> {
    try {
      const includeInactive = req.query.include_inactive === 'true';
      const limit = parseInt(req.query.limit as string) || 100;
      const page = parseInt(req.query.page as string) || 1;
      const sortBy = (req.query.sortBy as string) || 'stake';

      // Try to get from cache first
      const [cachedActive, cachedInactive, cachedStats] = await Promise.all([
        this.syncService.getCachedActiveValidators(),
        includeInactive ? this.syncService.getCachedInactiveValidators() : Promise.resolve(null),
        this.syncService.getCachedValidatorStats()
      ]);

      let activeValidators = cachedActive;
      let inactiveValidators = cachedInactive;

      // If not in cache, get from staking service
      if (!activeValidators) {
        activeValidators = await this.stakingService.getActiveValidators();
      }

      if (includeInactive && !inactiveValidators) {
        inactiveValidators = await this.stakingService.getInactiveValidators();
      }

      // Combine and sort validators
      let allValidators = activeValidators || [];
      if (includeInactive && inactiveValidators) {
        allValidators = [...allValidators, ...inactiveValidators];
      }

      // Sort validators
      allValidators.sort((a, b) => {
        switch (sortBy) {
          case 'stake':
            return parseInt(b.stake) - parseInt(a.stake);
          case 'commission':
            return parseInt(a.commission) - parseInt(b.commission);
          case 'validator_id':
            return a.validatorId.localeCompare(b.validatorId);
          default:
            return parseInt(b.stake) - parseInt(a.stake);
        }
      });

      // Apply pagination
      const offset = (page - 1) * limit;
      const paginatedValidators = allValidators.slice(offset, offset + limit);
      const totalCount = allValidators.length;
      const totalPages = Math.ceil(totalCount / limit);

      // Format response
      const formattedValidators = paginatedValidators.map(validator => ({
        validator_id: validator.validatorId,
        auth_address: validator.authAddress,
        stake: validator.stake,
        commission: validator.commission,
        status: validator.isActive ? 'active' : 'inactive',
        consensus_participation: {
          is_in_consensus_set: validator.isInConsensusSet,
          is_in_snapshot_set: validator.isInSnapshotSet,
          is_in_execution_set: validator.isInExecutionSet,
          consensus_stake: validator.consensusStake,
          consensus_commission: validator.consensusCommission
        },
        rewards: {
          unclaimed_reward: validator.unclaimedReward,
          acc_reward_per_token: validator.accRewardPerToken
        },
        keys: {
          secp_pubkey: validator.secpPubkey,
          bls_pubkey: validator.blsPubkey
        },
        flags: validator.flags
      }));

      res.json({
        data: formattedValidators,
        pagination: {
          current_page: page,
          total_pages: totalPages,
          total_count: totalCount,
          per_page: limit,
          has_next_page: page < totalPages,
          has_prev_page: page > 1
        },
        summary: {
          active_validators: cachedStats?.activeValidators || activeValidators?.length || 0,
          inactive_validators: cachedStats?.inactiveValidators || (includeInactive ? (inactiveValidators?.length || 0) : 'not_requested'),
          total_validators: cachedStats?.totalValidators || allValidators.length,
          current_epoch: cachedStats?.currentEpoch || 'unknown'
        },
        metadata: {
          version: 'v2',
          include_inactive: includeInactive,
          sort_by: sortBy,
          source: cachedActive ? 'cache' : 'staking_precompile'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get validators v2:', error);
      res.status(500).json({
        error: 'Failed to get validators',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get active validators only
   * NEW ENDPOINT: /api/v2/validators/active
   */
  async getActiveValidators(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const page = parseInt(req.query.page as string) || 1;
      
      // Try cache first
      let activeValidators = await this.syncService.getCachedActiveValidators();
      
      if (!activeValidators) {
        activeValidators = await this.stakingService.getActiveValidators();
      }

      // Apply pagination
      const offset = (page - 1) * limit;
      const paginatedValidators = activeValidators.slice(offset, offset + limit);
      const totalCount = activeValidators.length;
      const totalPages = Math.ceil(totalCount / limit);

      res.json({
        data: paginatedValidators.map(validator => ({
          validator_id: validator.validatorId,
          auth_address: validator.authAddress,
          stake: validator.stake,
          commission: validator.commission,
          consensus_stake: validator.consensusStake,
          rewards: {
            unclaimed_reward: validator.unclaimedReward,
            acc_reward_per_token: validator.accRewardPerToken
          }
        })),
        pagination: {
          current_page: page,
          total_pages: totalPages,
          total_count: totalCount,
          per_page: limit
        },
        metadata: {
          endpoint: 'active_validators',
          source: activeValidators === await this.syncService.getCachedActiveValidators() ? 'cache' : 'staking_precompile'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get active validators:', error);
      res.status(500).json({
        error: 'Failed to get active validators',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get inactive validators only
   * NEW ENDPOINT: /api/v2/validators/inactive
   */
  async getInactiveValidators(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const page = parseInt(req.query.page as string) || 1;
      
      // Try cache first
      let inactiveValidators = await this.syncService.getCachedInactiveValidators();
      
      if (!inactiveValidators) {
        inactiveValidators = await this.stakingService.getInactiveValidators();
      }

      // Apply pagination
      const offset = (page - 1) * limit;
      const paginatedValidators = inactiveValidators.slice(offset, offset + limit);
      const totalCount = inactiveValidators.length;
      const totalPages = Math.ceil(totalCount / limit);

      res.json({
        data: paginatedValidators.map(validator => ({
          validator_id: validator.validatorId,
          auth_address: validator.authAddress,
          stake: validator.stake,
          commission: validator.commission,
          execution_stake: validator.stake,
          reason_inactive: this.getInactiveReason(validator.flags)
        })),
        pagination: {
          current_page: page,
          total_pages: totalPages,
          total_count: totalCount,
          per_page: limit
        },
        metadata: {
          endpoint: 'inactive_validators',
          source: inactiveValidators === await this.syncService.getCachedInactiveValidators() ? 'cache' : 'staking_precompile'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get inactive validators:', error);
      res.status(500).json({
        error: 'Failed to get inactive validators',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get validator details with staking information
   * ENHANCED ENDPOINT: /api/v2/validators/:id
   */
  async getValidatorDetailsV2(req: Request, res: Response): Promise<void> {
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

      // Get validator from staking service
      const validator = await this.stakingService.getValidator(validatorId);
      
      if (!validator) {
        res.status(404).json({
          error: 'Validator not found',
          message: `Validator ${validatorId} not found`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Get performance metrics from existing system (if available)
      let performanceMetrics = null;
      try {
        const timeWindow = '24h';
        const blockProposalQuery = `
          SELECT 
            COUNT(*) as total_proposals,
            COUNT(CASE WHEN status = 'proposed' THEN 1 END) as successful_proposals,
            (COUNT(CASE WHEN status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as block_proposal_ratio
          FROM block_proposals
          WHERE validator_id = '${validatorId}'
            AND timestamp >= now() - INTERVAL ${timeWindow}
        `;

        const blockResult = await this.clickhouseClient.executeRawQuery(blockProposalQuery);
        const [blockData] = blockResult;
        
        if (blockData) {
          performanceMetrics = {
            block_proposal_ratio: parseFloat(blockData.block_proposal_ratio || 0),
            total_proposals: parseInt(blockData.total_proposals || 0),
            successful_proposals: parseInt(blockData.successful_proposals || 0)
          };
        }
      } catch (error) {
        logger.warn(`Failed to get performance metrics for validator ${validatorId}:`, error);
      }

      res.json({
        validator_id: validator.validatorId,
        auth_address: validator.authAddress,
        status: validator.isActive ? 'active' : 'inactive',
        staking: {
          stake: validator.stake,
          commission: validator.commission,
          consensus_stake: validator.consensusStake,
          consensus_commission: validator.consensusCommission,
          snapshot_stake: validator.snapshotStake,
          snapshot_commission: validator.snapshotCommission
        },
        participation: {
          is_in_consensus_set: validator.isInConsensusSet,
          is_in_snapshot_set: validator.isInSnapshotSet,
          is_in_execution_set: validator.isInExecutionSet
        },
        rewards: {
          unclaimed_reward: validator.unclaimedReward,
          acc_reward_per_token: validator.accRewardPerToken
        },
        keys: {
          secp_pubkey: validator.secpPubkey,
          bls_pubkey: validator.blsPubkey
        },
        flags: validator.flags,
        performance: performanceMetrics,
        metadata: {
          version: 'v2',
          source: 'staking_precompile'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get validator details v2:', error);
      res.status(500).json({
        error: 'Failed to get validator details',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get staking statistics
   * NEW ENDPOINT: /api/v2/validators/stats
   */
  async getStakingStats(req: Request, res: Response): Promise<void> {
    try {
      // Try cache first
      let stats = await this.syncService.getCachedValidatorStats();
      
      if (!stats) {
        stats = await this.stakingService.getValidatorStats();
      }

      // Get epoch information
      const epochInfo = await this.stakingService.getCurrentEpoch();

      res.json({
        validator_counts: {
          total: stats.totalValidators,
          active: stats.activeValidators,
          inactive: stats.inactiveValidators
        },
        set_sizes: {
          consensus: stats.consensusSetSize,
          execution: stats.executionSetSize,
          snapshot: stats.snapshotSetSize
        },
        epoch: {
          current: epochInfo.epoch,
          in_delay_period: epochInfo.inEpochDelayPeriod
        },
        sync_status: this.syncService.getStatus(),
        metadata: {
          last_updated: stats.lastUpdated || new Date().toISOString(),
          source: stats.lastUpdated ? 'cache' : 'staking_precompile'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get staking stats:', error);
      res.status(500).json({
        error: 'Failed to get staking statistics',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Force sync validators from staking precompile
   * NEW ENDPOINT: /api/v2/validators/sync
   */
  async forceSyncValidators(req: Request, res: Response): Promise<void> {
    try {
      logger.info('Manual validator sync requested via API');
      await this.syncService.forceSync();
      
      res.json({
        message: 'Validator sync completed successfully',
        sync_status: this.syncService.getStatus(),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to force sync validators:', error);
      res.status(500).json({
        error: 'Failed to sync validators',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // BACKWARD COMPATIBILITY METHODS
  // =============================================

  /**
   * Backward compatible validator rankings
   * ENHANCED: /api/validators/rankings (existing endpoint)
   */
  async getValidatorRankingsCompatible(req: Request, res: Response): Promise<void> {
    try {
      // Get active validators from staking service
      let activeValidators = await this.syncService.getCachedActiveValidators();
      
      if (!activeValidators) {
        activeValidators = await this.stakingService.getActiveValidators();
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const page = parseInt(req.query.page as string) || 1;
      
      // Convert to backward compatible format
      const rankings = activeValidators
        .slice((page - 1) * limit, page * limit)
        .map((validator, index) => ({
          rank: ((page - 1) * limit) + index + 1,
          validator_id: validator.validatorId,
          stake: parseInt(validator.stake),
          metrics: {
            uptime_score: 100, // Since these are active validators
            block_proposal_ratio: 0, // Would need historical data
            qc_participation_rate: 0 // Would need historical data
          },
          infrastructure: {
            validator_name: `Validator ${validator.validatorId}`,
            provider: 'unknown',
            location: 'unknown'
          }
        }));

      res.json({
        data: rankings,
        pagination: {
          current_page: page,
          total_pages: Math.ceil(activeValidators.length / limit),
          total_count: activeValidators.length,
          per_page: limit
        },
        metadata: {
          version: 'v1_compatible',
          source: 'staking_precompile',
          note: 'Enhanced with staking data while maintaining backward compatibility'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get compatible validator rankings:', error);
      res.status(500).json({
        error: 'Failed to get validator rankings',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // HELPER METHODS
  // =============================================

  private getInactiveReason(flags: number): string {
    // Based on validator flags, determine why validator is inactive
    // This is a simplified version - adjust based on actual flag definitions
    if (flags === 0) return 'insufficient_stake';
    if (flags & 1) return 'slashed';
    if (flags & 2) return 'jailed';
    return 'unknown';
  }
}
