// Monad Validator Analytics - Refactored Validator Controller
// Focus: Separate Validator Metrics (Block Proposals + QC Participation) + Staking Integration
import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { StakingUpdateService } from '../../services/staking/StakingUpdateService';
import { logger } from '../../utils/logger';

export class ValidatorController {
  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient,
    private stakingUpdateService?: StakingUpdateService
  ) {}

  // Method to update staking service after initialization
  async setStakingUpdateService(stakingUpdateService: StakingUpdateService | null): Promise<void> {
    this.stakingUpdateService = stakingUpdateService || undefined;
    logger.info('✅ StakingUpdateService updated in ValidatorController');
  }

  // =============================================
  // STAKING INTEGRATION METHODS
  // =============================================

  async getStakingInfo(req: Request, res: Response): Promise<void> {
    try {
      if (!this.stakingUpdateService) {
        res.status(503).json({
          error: 'Staking service not available',
          message: 'Staking integration is not configured',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const stats = this.stakingUpdateService.getStakingStats();
      const status = this.stakingUpdateService.getStatus();

      // Convert BigInt values to strings and wei to MON for JSON serialization
      const sanitizedStats = stats ? {
        ...stats,
        totalStake: stats.totalStake?.toString(),
        averageStake: stats.averageStake?.toString(),
        totalStakeMON: stats.totalStake ? (Number(stats.totalStake) / Math.pow(10, 18)).toFixed(4) : "0",
        averageStakeMON: stats.averageStake ? (Number(stats.averageStake) / Math.pow(10, 18)).toFixed(4) : "0",
        currentEpoch: stats.currentEpoch?.toString()
      } : null;

      const sanitizedStatus = {
        ...status,
        lastStakingInfo: status.lastStakingInfo ? {
          ...status.lastStakingInfo,
          currentEpoch: status.lastStakingInfo.currentEpoch?.toString(),
          // Convert validatorStakes Map with BigInt values to serializable object with MON conversion
          validatorStakes: status.lastStakingInfo.validatorStakes ? 
            Object.fromEntries(
              Array.from((status.lastStakingInfo.validatorStakes as Map<string, bigint>).entries())
                .map(([key, value]: [string, bigint]) => [
                  key, 
                  {
                    wei: value.toString(),
                    mon: (Number(value) / Math.pow(10, 18)).toFixed(4)
                  }
                ])
            ) : null,
          // Convert Sets to arrays
          activeValidators: status.lastStakingInfo.activeValidators ? 
            Array.from(status.lastStakingInfo.activeValidators) : [],
          consensusValidators: status.lastStakingInfo.consensusValidators ? 
            Array.from(status.lastStakingInfo.consensusValidators) : [],
          executionValidators: status.lastStakingInfo.executionValidators ? 
            Array.from(status.lastStakingInfo.executionValidators) : []
        } : null
      };

      res.json({
        stakingStats: sanitizedStats,
        serviceStatus: sanitizedStatus,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get staking info:', error);
      res.status(500).json({
        error: 'Failed to get staking info',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async forceStakingUpdate(req: Request, res: Response): Promise<void> {
    try {
      if (!this.stakingUpdateService) {
        res.status(503).json({
          error: 'Staking service not available',
          message: 'Staking integration is not configured',
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.info('🔄 Force staking update requested');
      await this.stakingUpdateService.forceUpdate();

      res.json({
        message: 'Staking update completed successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to force staking update:', error);
      res.status(500).json({
        error: 'Failed to force staking update',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // VALIDATOR RANKINGS (Separate Metrics + Staking)
  // =============================================

  async getValidatorRankings(req: Request, res: Response): Promise<void> {
    try {
      const timeWindow = (req.query.window as string) || '1h';
      const limit = parseInt(req.query.limit as string) || 50;
      const page = parseInt(req.query.page as string) || 1;
      const sortBy = (req.query.sortBy as string) || 'uptime_score';
      const activeOnly = req.query.active_only !== 'false'; // Default true, false only if explicitly set to 'false'
      
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

      if (page < 1) {
        res.status(400).json({
          error: 'Invalid page parameter',
          message: 'Page must be >= 1',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (!['uptime_score', 'block_proposal_ratio', 'qc_participation_rate', 'stake'].includes(sortBy)) {
        res.status(400).json({
          error: 'Invalid sortBy parameter',
          message: 'Must be uptime_score, block_proposal_ratio, qc_participation_rate, or stake',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Force table optimization to ensure no duplicates exist
      await this.ensureNoDuplicates();

      // Try cache first - include activeOnly in cache key
      const cacheKey = `validator_rankings:${timeWindow}:${limit}:${page}:${sortBy}:${activeOnly}`;
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        const cachedData = JSON.parse(cached);
        res.json({
          data: cachedData.data,
          pagination: cachedData.pagination,
          metadata: {
            timeWindow,
            limit,
            page,
            sortBy,
            activeOnly,
            source: 'cache',
            formula: 'block_proposal_ratio * 0.7 + qc_participation_rate * 0.3'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Calculate rankings with pagination from raw data
      const result = await this.calculateValidatorRankingsWithPagination(timeWindow, limit, page, sortBy, activeOnly);
      
      // Cache result for 2 minutes (rankings update frequently)
      await this.redisClient['client'].setex(cacheKey, 120, JSON.stringify(result));
      
      res.json({
        data: result.data,
        pagination: result.pagination,
        metadata: {
          timeWindow,
          limit,
          page,
          sortBy,
          activeOnly,
          source: 'database',
          formula: 'block_proposal_ratio * 0.7 + qc_participation_rate * 0.3'
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

      const timeWindow = this.getIntervalClause('24h');
      
      // Get block proposal metrics with provider info from validator_registry
      const blockProposalQuery = `
        SELECT 
          b.validator_id,
          COUNT(*) as total_proposals,
          COUNT(CASE WHEN b.status = 'proposed' THEN 1 END) as successful_proposals,
          COUNT(CASE WHEN b.status = 'skipped' THEN 1 END) as skipped_proposals,
          (COUNT(CASE WHEN b.status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as block_proposal_ratio,
          COALESCE(vr.validator_name, 'unknown') as validator_name,
          COALESCE(vr.provider, 'unknown') as provider,
          COALESCE(vr.location, 'unknown') as location,
          COALESCE(vr.stake, 0) as stake,
          COALESCE(vr.keybase_id, '') as keybase_id,
          COALESCE(vr.keybase_logo_url, '') as keybase_logo_url,
          MIN(b.timestamp) as first_seen,
          MAX(b.timestamp) as last_activity
        FROM block_proposals b
        LEFT JOIN validator_registry vr ON vr.validator_id = b.validator_id AND vr.is_active = 1
        WHERE b.validator_id = '${validatorId}'
          AND b.timestamp >= now() - INTERVAL ${timeWindow}
        GROUP BY b.validator_id, vr.validator_name, vr.provider, vr.location, vr.stake, vr.keybase_id, vr.keybase_logo_url
      `;

      // Get QC participation metrics
      const qcParticipationQuery = `
        SELECT 
          validator_id,
          COUNT(*) as total_qc_opportunities,
          COUNT(CASE WHEN participated = 1 THEN 1 END) as qc_participations,
          (COUNT(CASE WHEN participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as qc_participation_rate,
          AVG(participation_rate) as avg_network_participation_rate
        FROM qc_participation
        WHERE validator_id = '${validatorId}'
          AND timestamp >= now() - INTERVAL ${timeWindow}
        GROUP BY validator_id
      `;

      const [blockResult, qcResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(blockProposalQuery),
        this.clickhouseClient.executeRawQuery(qcParticipationQuery)
      ]);

      const [blockData] = blockResult;
      const [qcData] = qcResult;
      
      if (!blockData && !qcData) {
        res.status(404).json({
          error: 'Validator not found',
          message: `No data found for validator ${validatorId} in the last 24 hours`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Calculate combined uptime score
      const blockRatio = parseFloat(blockData?.block_proposal_ratio || 0);
      const qcRate = parseFloat(qcData?.qc_participation_rate || 0);
      const uptimeScore = blockRatio * 0.7 + qcRate * 0.3;

      // DATABASE-FIRST: Get staking information from database
      let stakingInfo = null;
      try {
        const stakingQuery = `
          SELECT 
            precompile_validator_id,
            is_staking_active,
            real_time_stake_wei
          FROM validator_registry 
          WHERE validator_id = '${validatorId}'
          ORDER BY last_updated DESC 
          LIMIT 1
        `;
        
        const stakingResult = await this.clickhouseClient.executeRawQuery(stakingQuery);
        const stakingData = stakingResult[0];
        
        if (stakingData) {
          // Convert wei to MON (1 MON = 10^18 wei)
          const realTimeStakeMON = stakingData.real_time_stake_wei 
            ? (Number(stakingData.real_time_stake_wei) / Math.pow(10, 18)).toFixed(4)
            : "0";
            
          stakingInfo = {
            is_staking_active: Boolean(stakingData.is_staking_active),
            real_time_stake_mon: realTimeStakeMON,
            real_time_stake_wei: stakingData.real_time_stake_wei || "0",
            precompile_validator_id: stakingData.precompile_validator_id || null
          };
        }
      } catch (error) {
        logger.warn(`Failed to get staking info for validator ${validatorId}:`, error);
      }

      // Format response with separate metrics
      res.json({
        validator_id: validatorId,
        stake: parseInt(blockData?.stake || 0),
        staking: stakingInfo,
        metrics: {
          block_proposal_ratio: blockRatio,
          qc_participation_rate: qcRate,
          uptime_score: uptimeScore
        },
        details: {
          block_proposals: {
            total_opportunities: parseInt(blockData?.total_proposals || 0),
            successful_proposals: parseInt(blockData?.successful_proposals || 0),
            skipped_proposals: parseInt(blockData?.skipped_proposals || 0)
          },
          qc_participation: {
            total_opportunities: parseInt(qcData?.total_qc_opportunities || 0),
            participations: parseInt(qcData?.qc_participations || 0),
            avg_network_participation_rate: parseFloat(qcData?.avg_network_participation_rate || 0)
          }
        },
        infrastructure: {
          validator_name: blockData?.validator_name || 'unknown',
          provider: blockData?.provider || 'unknown',
          location: blockData?.location || 'unknown'
        },
        keybase: {
          id: blockData?.keybase_id || null,
          logo_url: blockData?.keybase_logo_url || null
        },
        activity: {
          first_seen: blockData?.first_seen || null,
          last_activity: blockData?.last_activity || null
        },
        metadata: {
          time_window: '24h',
          uptime_formula: 'block_proposal_ratio * 0.7 + qc_participation_rate * 0.3'
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
      const cached = await this.redisClient['client'].get(cacheKey);
      
      if (cached) {
        res.json({
          validatorId,
          history: JSON.parse(cached),
          metadata: {
            hours,
            source: 'cache'
          },
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Get hourly aggregated data
      const history = await this.getValidatorHourlyHistory(validatorId, hours);
      
      // Cache result for 5 minutes
      await this.redisClient['client'].setex(cacheKey, 300, JSON.stringify(history));
      
      res.json({
        validatorId,
        history,
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

      const comparison = await this.compareValidatorsMetrics(validatorIds, timeWindow);
      
      res.json({
        comparison,
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

  private async calculateValidatorRankingsWithPagination(timeWindow: string, limit: number, page: number, sortBy: string, activeOnly: boolean = true): Promise<{ data: any[], pagination: any }> {
    const intervalClause = this.getIntervalClause(timeWindow);
    const offset = (page - 1) * limit;
    
    const activeValidatorsCTE = this.buildActiveValidatorsCTE(activeOnly);

    // First, get the total count - use aggregated latest validator records to ensure accuracy
    const countQuery = `
      WITH 
        active_validators AS (
          ${activeValidatorsCTE}
        )
      SELECT COUNT(*) as total_count
      FROM active_validators
    `;

    // Main query with pagination and stake amounts - ONLY include validators in validator_registry
    // Use aggregated latest record per validator to prevent duplicates
    const query = `
      WITH 
        active_validators AS (
          ${activeValidatorsCTE}
        ),
        block_metrics AS (
          SELECT 
            bp.validator_id,
            COUNT(*) as total_block_opportunities,
            COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) as blocks_proposed,
            COUNT(CASE WHEN bp.status = 'skipped' THEN 1 END) as blocks_skipped,
            (COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as block_proposal_ratio
          FROM block_proposals bp
          INNER JOIN active_validators av ON bp.validator_id = av.validator_id
          WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
          GROUP BY bp.validator_id
        ),
        qc_metrics AS (
          SELECT 
            qc.validator_id,
            COUNT(*) as total_qc_opportunities,
            COUNT(CASE WHEN qc.participated = 1 THEN 1 END) as qc_participations,
            (COUNT(CASE WHEN qc.participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as qc_participation_rate
          FROM qc_participation qc
          INNER JOIN active_validators av ON qc.validator_id = av.validator_id
          WHERE qc.timestamp >= now() - INTERVAL ${intervalClause}
          GROUP BY qc.validator_id
        )
      SELECT 
        av.validator_id as validator_id,
        COALESCE(b.block_proposal_ratio, 0) as block_proposal_ratio,
        COALESCE(q.qc_participation_rate, 0) as qc_participation_rate,
        (COALESCE(b.block_proposal_ratio, 0) * 0.7 + COALESCE(q.qc_participation_rate, 0) * 0.3) as uptime_score,
        COALESCE(b.total_block_opportunities, 0) as total_block_opportunities,
        COALESCE(b.blocks_proposed, 0) as blocks_proposed,
        COALESCE(b.blocks_skipped, 0) as blocks_skipped,
        COALESCE(q.total_qc_opportunities, 0) as total_qc_opportunities,
        COALESCE(q.qc_participations, 0) as qc_participations,
        av.validator_name as validator_name,
        av.provider as provider,
        av.location as location,
        av.stake as stake,
        av.keybase_id as keybase_id,
        av.keybase_logo_url as keybase_logo_url,
        av.precompile_validator_id as precompile_validator_id,
        av.is_staking_active as is_staking_active,
        av.real_time_stake_wei as real_time_stake_wei
      FROM active_validators av
      LEFT JOIN block_metrics b ON av.validator_id = b.validator_id
      LEFT JOIN qc_metrics q ON av.validator_id = q.validator_id
      ORDER BY ${this.getSortByClause(sortBy)}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [countResult, dataResult] = await Promise.all([
      this.clickhouseClient.executeRawQuery(countQuery),
      this.clickhouseClient.executeRawQuery(query)
    ]);

    const totalCount = countResult[0]?.total_count || 0;
    const totalPages = Math.ceil(totalCount / limit);
    
    const rankings = dataResult.map((r, index) => {
      // DATABASE-FIRST: Staking information is already in validator_registry table
      let stakingInfo = {
        is_staking_active: Boolean(r.is_staking_active),
        real_time_stake_mon: r.real_time_stake_wei ? 
          (Number(r.real_time_stake_wei) / Math.pow(10, 18)).toFixed(4) : "0",
        real_time_stake_wei: r.real_time_stake_wei || "0",
        database_stake: parseInt(r.stake || 0),
        precompile_validator_id: r.precompile_validator_id || null
      };

      return {
        rank: offset + index + 1,
        validator_id: r.validator_id,
        stake: parseInt(r.stake || 0),
        staking: stakingInfo,
        metrics: {
          block_proposal_ratio: parseFloat(r.block_proposal_ratio || 0),
          qc_participation_rate: parseFloat(r.qc_participation_rate || 0),
          uptime_score: parseFloat(r.uptime_score || 0)
        },
        details: {
          total_block_opportunities: parseInt(r.total_block_opportunities || 0),
          total_qc_opportunities: parseInt(r.total_qc_opportunities || 0),
          blocks_proposed: parseInt(r.blocks_proposed || 0),
          blocks_skipped: parseInt(r.blocks_skipped || 0),
          qc_participations: parseInt(r.qc_participations || 0)
        },
        infrastructure: {
          validator_name: r.validator_name || 'unknown',
          provider: r.provider || 'unknown',
          location: r.location || 'unknown'
        },
        keybase: {
          id: r.keybase_id || null,
          logo_url: r.keybase_logo_url || null
        }
      };
    });

    return {
      data: rankings,
      pagination: {
        current_page: page,
        total_pages: totalPages,
        total_count: totalCount,
        per_page: limit,
        has_next_page: page < totalPages,
        has_prev_page: page > 1
      }
    };
  }

  private buildActiveValidatorsCTE(activeOnly: boolean): string {
    const activeFilter = activeOnly ? 'AND is_staking_active = 1' : '';

    return `
      SELECT
        validator_id,
        validator_name,
        provider,
        location,
        stake,
        keybase_id,
        keybase_logo_url,
        precompile_validator_id,
        is_staking_active,
        real_time_stake_wei
      FROM (
        SELECT
          validator_id,
          validator_name,
          provider,
          location,
          stake,
          keybase_id,
          keybase_logo_url,
          precompile_validator_id,
          is_staking_active,
          real_time_stake_wei,
          ROW_NUMBER() OVER (PARTITION BY validator_id ORDER BY last_updated DESC) as rn
        FROM validator_registry
        WHERE is_active = 1
      )
      WHERE rn = 1
      ${activeFilter}
    `;
  }

  private async calculateValidatorRankings(timeWindow: string, limit: number, sortBy: string): Promise<any[]> {
    const intervalClause = this.getIntervalClause(timeWindow);
    
    // Combined query to get both block proposal and QC participation metrics
    // IMPORTANT: Only include validators that exist in validator_registry with is_active = 1
    // Use latest snapshot per validator (window function) to prevent duplicates cleanly
    const activeValidatorsCTE = this.buildActiveValidatorsCTE(true);

    const query = `
      WITH 
        active_validators AS (
          ${activeValidatorsCTE}
        ),
        block_metrics AS (
          SELECT 
            bp.validator_id,
            COUNT(*) as total_block_opportunities,
            COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) as blocks_proposed,
            COUNT(CASE WHEN bp.status = 'skipped' THEN 1 END) as blocks_skipped,
            (COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as block_proposal_ratio
          FROM block_proposals bp
          INNER JOIN active_validators av ON bp.validator_id = av.validator_id
          WHERE bp.timestamp >= now() - INTERVAL ${intervalClause}
          GROUP BY bp.validator_id
        ),
        qc_metrics AS (
          SELECT 
            qc.validator_id,
            COUNT(*) as total_qc_opportunities,
            COUNT(CASE WHEN qc.participated = 1 THEN 1 END) as qc_participations,
            (COUNT(CASE WHEN qc.participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as qc_participation_rate
          FROM qc_participation qc
          INNER JOIN active_validators av ON qc.validator_id = av.validator_id
          WHERE qc.timestamp >= now() - INTERVAL ${intervalClause}
          GROUP BY qc.validator_id
        )
      SELECT 
        av.validator_id as validator_id,
        COALESCE(b.block_proposal_ratio, 0) as block_proposal_ratio,
        COALESCE(q.qc_participation_rate, 0) as qc_participation_rate,
        (COALESCE(b.block_proposal_ratio, 0) * 0.7 + COALESCE(q.qc_participation_rate, 0) * 0.3) as uptime_score,
        COALESCE(b.total_block_opportunities, 0) as total_block_opportunities,
        COALESCE(b.blocks_proposed, 0) as blocks_proposed,
        COALESCE(b.blocks_skipped, 0) as blocks_skipped,
        COALESCE(q.total_qc_opportunities, 0) as total_qc_opportunities,
        COALESCE(q.qc_participations, 0) as qc_participations,
        av.validator_name as validator_name,
        av.provider as provider,
        av.location as location,
        av.stake as stake,
        av.keybase_id as keybase_id,
        av.keybase_logo_url as keybase_logo_url,
        av.precompile_validator_id as precompile_validator_id,
        av.is_staking_active as is_staking_active,
        av.real_time_stake_wei as real_time_stake_wei
      FROM active_validators av
      LEFT JOIN block_metrics b ON av.validator_id = b.validator_id
      LEFT JOIN qc_metrics q ON av.validator_id = q.validator_id
      ORDER BY ${this.getSortByClause(sortBy)}
      LIMIT ${limit}
    `;

    const result = await this.clickhouseClient.executeRawQuery(query);

    const rankings = result;
    
    return rankings.map((r, index) => {
      // DATABASE-FIRST: Staking information already available in query result
      let stakingInfo = {
        is_staking_active: Boolean(r.is_staking_active),
        real_time_stake_mon: r.real_time_stake_wei ? 
          (Number(r.real_time_stake_wei) / Math.pow(10, 18)).toFixed(4) : "0",
        real_time_stake_wei: r.real_time_stake_wei || "0",
        database_stake: parseInt(r.stake || 0),
        precompile_validator_id: r.precompile_validator_id || null
      };

      return {
        rank: index + 1,
        validator_id: r.validator_id,
        stake: parseInt(r.stake || 0),
        staking: stakingInfo,
        metrics: {
          block_proposal_ratio: parseFloat(r.block_proposal_ratio || 0),
          qc_participation_rate: parseFloat(r.qc_participation_rate || 0),
          uptime_score: parseFloat(r.uptime_score || 0)
        },
        details: {
          total_block_opportunities: parseInt(r.total_block_opportunities || 0),
          total_qc_opportunities: parseInt(r.total_qc_opportunities || 0),
          blocks_proposed: parseInt(r.blocks_proposed || 0),
          blocks_skipped: parseInt(r.blocks_skipped || 0),
          qc_participations: parseInt(r.qc_participations || 0)
        },
        infrastructure: {
          validator_name: r.validator_name || 'unknown',
          provider: r.provider || 'unknown',
          location: r.location || 'unknown'
        },
        keybase: {
          id: r.keybase_id || null,
          logo_url: r.keybase_logo_url || null
        }
      };
    });
  }

  private async getValidatorHourlyHistory(validatorId: string, hours: number): Promise<any[]> {
    // Get hourly aggregated block proposal data
    const blockQuery = `
      SELECT 
        toStartOfHour(timestamp) as hour,
        COUNT(*) as block_opportunities,
        COUNT(CASE WHEN status = 'proposed' THEN 1 END) as blocks_proposed,
        COUNT(CASE WHEN status = 'skipped' THEN 1 END) as blocks_skipped,
        (COUNT(CASE WHEN status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as block_proposal_ratio
      FROM block_proposals
      WHERE validator_id = '${validatorId}'
        AND timestamp >= now() - INTERVAL ${hours} HOUR
      GROUP BY hour
      ORDER BY hour
    `;

    // Get hourly aggregated QC participation data
    const qcQuery = `
      SELECT 
        toStartOfHour(timestamp) as hour,
        COUNT(*) as qc_opportunities,
        COUNT(CASE WHEN participated = 1 THEN 1 END) as qc_participations,
        (COUNT(CASE WHEN participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as qc_participation_rate
      FROM qc_participation
      WHERE validator_id = '${validatorId}'
        AND timestamp >= now() - INTERVAL ${hours} HOUR
      GROUP BY hour
      ORDER BY hour
    `;

    const [blockResult, qcResult] = await Promise.all([
      this.clickhouseClient.executeRawQuery(blockQuery),
      this.clickhouseClient.executeRawQuery(qcQuery)
    ]);

    const blockData = blockResult;
    const qcData = qcResult;

    // Merge data by hour
    const hourlyData = new Map<string, any>();
    
    blockData.forEach(b => {
      hourlyData.set(b.hour, {
        hour: b.hour,
        block_opportunities: parseInt(b.block_opportunities || 0),
        blocks_proposed: parseInt(b.blocks_proposed || 0),
        blocks_skipped: parseInt(b.blocks_skipped || 0),
        block_proposal_ratio: parseFloat(b.block_proposal_ratio || 0),
        qc_opportunities: 0,
        qc_participations: 0,
        qc_participation_rate: 0
      });
    });

    qcData.forEach(q => {
      const existing = hourlyData.get(q.hour) || {
        hour: q.hour,
        block_opportunities: 0,
        blocks_proposed: 0,
        blocks_skipped: 0,
        block_proposal_ratio: 0
      };
      
      existing.qc_opportunities = parseInt(q.qc_opportunities || 0);
      existing.qc_participations = parseInt(q.qc_participations || 0);
      existing.qc_participation_rate = parseFloat(q.qc_participation_rate || 0);
      
      hourlyData.set(q.hour, existing);
    });

    // Convert to array and calculate uptime scores
    return Array.from(hourlyData.values()).map(h => ({
      hour: h.hour,
      metrics: {
        block_proposal_ratio: h.block_proposal_ratio,
        qc_participation_rate: h.qc_participation_rate,
        uptime_score: h.block_proposal_ratio * 0.7 + h.qc_participation_rate * 0.3
      },
      activity: {
        block_opportunities: h.block_opportunities,
        blocks_proposed: h.blocks_proposed,
        blocks_skipped: h.blocks_skipped,
        qc_opportunities: h.qc_opportunities,
        qc_participations: h.qc_participations
      }
    })).sort((a, b) => a.hour.localeCompare(b.hour));
  }

  private async compareValidatorsMetrics(validatorIds: string[], timeWindow: string): Promise<any[]> {
    const validatorIdList = validatorIds.map(id => `'${id}'`).join(',');
    const intervalClause = this.getIntervalClause(timeWindow);

    const query = `
      WITH 
        block_metrics AS (
          SELECT 
            validator_id,
            COUNT(*) as total_block_opportunities,
            COUNT(CASE WHEN status = 'proposed' THEN 1 END) as blocks_proposed,
            COUNT(CASE WHEN status = 'skipped' THEN 1 END) as blocks_skipped,
            (COUNT(CASE WHEN status = 'proposed' THEN 1 END) * 100.0 / COUNT(*)) as block_proposal_ratio
          FROM block_proposals
          WHERE validator_id IN (${validatorIdList})
            AND timestamp >= now() - INTERVAL ${intervalClause}
          GROUP BY validator_id
        ),
        qc_metrics AS (
          SELECT 
            validator_id,
            COUNT(*) as total_qc_opportunities,
            COUNT(CASE WHEN participated = 1 THEN 1 END) as qc_participations,
            (COUNT(CASE WHEN participated = 1 THEN 1 END) * 100.0 / COUNT(*)) as qc_participation_rate
          FROM qc_participation
          WHERE validator_id IN (${validatorIdList})
            AND timestamp >= now() - INTERVAL ${intervalClause}
          GROUP BY validator_id
        )
      SELECT 
        COALESCE(b.validator_id, q.validator_id) as validator_id,
        COALESCE(b.block_proposal_ratio, 0) as block_proposal_ratio,
        COALESCE(q.qc_participation_rate, 0) as qc_participation_rate,
        (COALESCE(b.block_proposal_ratio, 0) * 0.7 + COALESCE(q.qc_participation_rate, 0) * 0.3) as uptime_score,
        COALESCE(b.total_block_opportunities, 0) as total_block_opportunities,
        COALESCE(b.blocks_proposed, 0) as blocks_proposed,
        COALESCE(b.blocks_skipped, 0) as blocks_skipped,
        COALESCE(q.total_qc_opportunities, 0) as total_qc_opportunities,
        COALESCE(q.qc_participations, 0) as qc_participations,
        COALESCE(vr.validator_name, 'unknown') as validator_name,
        COALESCE(vr.provider, 'unknown') as provider,
        COALESCE(vr.location, 'unknown') as location,
        COALESCE(vr.stake, 0) as stake,
        COALESCE(vr.keybase_id, '') as keybase_id,
        COALESCE(vr.keybase_logo_url, '') as keybase_logo_url
      FROM block_metrics b
      FULL OUTER JOIN qc_metrics q ON b.validator_id = q.validator_id
      LEFT JOIN validator_registry vr ON vr.validator_id = COALESCE(b.validator_id, q.validator_id) AND vr.is_active = 1
      ORDER BY uptime_score DESC
    `;

    const result = await this.clickhouseClient.executeRawQuery(query);

    const comparison = result;
    
    return comparison.map(v => ({
      validator_id: v.validator_id,
      stake: parseInt(v.stake || 0),
      metrics: {
        block_proposal_ratio: parseFloat(v.block_proposal_ratio || 0),
        qc_participation_rate: parseFloat(v.qc_participation_rate || 0),
        uptime_score: parseFloat(v.uptime_score || 0)
      },
      totals: {
        total_block_opportunities: parseInt(v.total_block_opportunities || 0),
        blocks_proposed: parseInt(v.blocks_proposed || 0),
        blocks_skipped: parseInt(v.blocks_skipped || 0),
        total_qc_opportunities: parseInt(v.total_qc_opportunities || 0),
        qc_participations: parseInt(v.qc_participations || 0)
      },
      infrastructure: {
        validator_name: v.validator_name || 'unknown',
        provider: v.provider || 'unknown',
        location: v.location || 'unknown'
      },
      keybase: {
        id: v.keybase_id || null,
        logo_url: v.keybase_logo_url || null
      }
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

  private getSortByClause(sortBy: string): string {
    switch (sortBy) {
      case 'block_proposal_ratio':
        return 'block_proposal_ratio DESC, uptime_score DESC';
      case 'qc_participation_rate':
        return 'qc_participation_rate DESC, uptime_score DESC';
      case 'stake':
        return 'stake DESC, uptime_score DESC';
      case 'uptime_score':
      default:
        return 'uptime_score DESC, block_proposal_ratio DESC';
    }
  }

  // =============================================
  // DUPLICATE PREVENTION HELPER
  // =============================================

  private async ensureNoDuplicates(): Promise<void> {
    try {
      // Check if we need to optimize the table (detect duplicates)
      const duplicateCheckQuery = `
        SELECT validator_id
        FROM validator_registry
        WHERE is_active = 1
        GROUP BY validator_id, epoch, last_updated
        HAVING COUNT(*) > 1
        LIMIT 1
      `;
      
      const duplicateResult = await this.clickhouseClient.executeRawQuery(duplicateCheckQuery);
      
      if (duplicateResult.length > 0) {
        logger.warn('🔧 Detected duplicate validators, optimizing table...');
        
        // Force table optimization to merge duplicates
        await this.clickhouseClient.executeCommand('OPTIMIZE TABLE validator_registry FINAL');
        
        // Clear related cache entries
        await this.redisClient.invalidatePattern('validator_*');
        
        logger.info('✅ Table optimization and cache clearing completed');
      }
    } catch (error) {
      logger.warn('Failed to check/fix duplicates:', error);
      // Don't throw - this is a best effort optimization
    }
  }
}
