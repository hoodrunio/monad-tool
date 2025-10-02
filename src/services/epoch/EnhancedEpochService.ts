/**
 * Enhanced Epoch Service (Protocol-Accurate)
 * 
 * Implements protocol-accurate epoch tracking with:
 * 1. Staking precompile getEpoch() as canonical source of truth
 * 2. DB round/seq_num for progress calculation
 * 3. Robust ABT with outlier handling
 * 4. Staleness detection and degradation
 * 5. Delay period tracking (500 rounds configurable)
 * 
 * State machine:
 * - Normal phase: progress to boundary using rounds
 * - Delay phase: progress within delay window using rounds
 * - Stale: suppress progress, flag staleness
 * 
 * Precedence: getEpoch() → DB rounds → degraded state
 */

import { ClickHouseClient } from '@clickhouse/client';
import { logger } from '../../utils';
import { NodeRpcClient } from '../blockchain/NodeRpcClient';
import { StakingPrecompileClient } from './StakingPrecompileClient';
import { AverageBlockTimeCalculator } from './AverageBlockTimeCalculator';
import { StalenessDetector } from './StalenessDetector';
import { EpochConfig } from './EpochConfig';
import {
  EnhancedEpochInfo,
  EpochProgressInfo,
  EpochPhase,
  DelayConfig,
  RoundBlockInfo,
  EpochBoundary,
} from './types';

export class EnhancedEpochService {
  private precompileClient: StakingPrecompileClient;
  private abtCalculator: AverageBlockTimeCalculator;
  private stalenessDetector: StalenessDetector;
  private config: EpochConfig;
  
  // Epoch interval in blocks (e.g., 5000)
  private readonly epochInterval: number;

  constructor(
    private readonly clickhouse: ClickHouseClient,
    private readonly rpcClient: NodeRpcClient,
    epochInterval: number = 5000
  ) {
    this.config = EpochConfig.getInstance();
    this.epochInterval = epochInterval;
    
    this.precompileClient = new StakingPrecompileClient(
      this.config.getRpcUrl(),
      this.config.getStakingPrecompileAddress()
    );
    
    this.abtCalculator = new AverageBlockTimeCalculator(clickhouse, this.config);
    this.stalenessDetector = new StalenessDetector(clickhouse, rpcClient, this.config);
    
    logger.info('EnhancedEpochService initialized', {
      epochInterval,
      delayRounds: this.config.getDelayPeriodRounds(),
      abtSampleSize: this.config.getAbtSampleSize(),
    });
  }

  /**
   * Get comprehensive protocol-accurate epoch information
   */
  async getEpochInfo(): Promise<EnhancedEpochInfo> {
    try {
      logger.info('Fetching enhanced epoch info...');

      // 1. Check staleness first
      const staleness = await this.stalenessDetector.checkStaleness();
      
      // 2. Try to get canonical epoch from precompile
      let precompileAvailable = false;
      let epochId = 0;
      let inEpochDelayPeriod = false;
      
      try {
        const precompileData = await this.precompileClient.getEpoch();
        epochId = Number(precompileData.epoch);
        inEpochDelayPeriod = precompileData.inEpochDelayPeriod;
        precompileAvailable = true;
        
        logger.info('Precompile epoch data retrieved', {
          epochId,
          inDelayPeriod: inEpochDelayPeriod,
        });
      } catch (error) {
        logger.warn('Precompile unavailable, using best-effort epoch from DB', {
          error: error instanceof Error ? error.message : String(error),
        });
        
        // Fallback: estimate epoch from DB
        epochId = await this.estimateEpochFromDb();
      }

      // 3. Compute ABT
      let abt = null;
      try {
        abt = await this.abtCalculator.computeAbt();
      } catch (error) {
        logger.warn('ABT computation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 4. Build progress information based on state
      let progress: EpochProgressInfo;
      let delayConfig: DelayConfig;
      
      if (staleness.isStale) {
        // STALE STATE: suppress progress
        progress = this.buildStaleProgress(staleness);
        delayConfig = await this.buildDelayConfig(false, null);
      } else if (!precompileAvailable) {
        // NO PRECOMPILE: best-effort with warning
        progress = await this.buildBestEffortProgress(epochId);
        delayConfig = await this.buildDelayConfig(false, null);
      } else if (inEpochDelayPeriod) {
        // DELAY PHASE: track delay progress
        const currentRoundInfo = await this.getCurrentRoundInfo();
        progress = await this.buildDelayPhaseProgress(epochId, currentRoundInfo);
        delayConfig = await this.buildDelayConfig(true, currentRoundInfo);
      } else {
        // NORMAL PHASE: track progress to boundary
        const currentRoundInfo = await this.getCurrentRoundInfo();
        progress = await this.buildNormalPhaseProgress(epochId, currentRoundInfo);
        delayConfig = await this.buildDelayConfig(false, null);
      }

      const result: EnhancedEpochInfo = {
        epochId,
        inEpochDelayPeriod,
        progress,
        delayConfig,
        abt,
        staleness,
        timestamp: new Date(),
        precompileAvailable,
      };

      logger.info('Enhanced epoch info computed', {
        epochId,
        phase: progress.phase,
        inDelayPeriod: inEpochDelayPeriod,
        isStale: staleness.isStale,
      });

      return result;
    } catch (error) {
      logger.error('Failed to get enhanced epoch info', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Build progress for NORMAL phase (before boundary)
   * Uses block numbers for progress calculation
   */
  private async buildNormalPhaseProgress(epochId: number, currentRound: RoundBlockInfo): Promise<EpochProgressInfo> {
    // Normal phase: block-based calculation
    const epochStartBlock = (epochId - 1) * this.epochInterval;
    const epochEndBlock = epochId * this.epochInterval - 1;
    const currentBlock = currentRound.seq_num;
    
    const blocksCompleted = currentBlock - epochStartBlock;
    const blocksRemaining = epochEndBlock - currentBlock;
    
    const progressValue = blocksCompleted / this.epochInterval;
    const progressPercentage = progressValue * 100;

    return {
      phase: 'normal',
      value: Math.min(1, Math.max(0, progressValue)),
      percentage: Math.min(100, Math.max(0, progressPercentage)),
      explanation: `Epoch ${epochId} in progress: ${blocksCompleted} of ${this.epochInterval} blocks completed`,
      currentRound: currentRound.round, // Show round for info
      epochStartRound: epochStartBlock,
      epochBoundaryRound: epochEndBlock,
      roundsCompleted: blocksCompleted,
      roundsToNextEpoch: blocksRemaining,
    };
  }

  /**
   * Build progress for DELAY phase (after boundary, before new epoch)
   * Uses rounds for delay period tracking
   */
  private async buildDelayPhaseProgress(epochId: number, currentRound: RoundBlockInfo): Promise<EpochProgressInfo> {
    const delayRounds = this.config.getDelayPeriodRounds();
    
    // Get the round range for current epoch to find boundary
    const epochRoundRange = await this.getEpochRoundRange(epochId);
    const boundaryRound = epochRoundRange.maxRound; // Last round of epoch
    
    const elapsedDelayRounds = currentRound.round - boundaryRound;
    const remainingDelayRounds = delayRounds - elapsedDelayRounds;
    
    const progressValue = elapsedDelayRounds / delayRounds;
    const progressPercentage = progressValue * 100;

    return {
      phase: 'delay',
      value: Math.min(1, Math.max(0, progressValue)),
      percentage: Math.min(100, Math.max(0, progressPercentage)),
      explanation: `In delay period: ${elapsedDelayRounds} of ${delayRounds} rounds elapsed, waiting for epoch ${epochId + 1}`,
      currentRound: currentRound.round,
      epochStartRound: epochRoundRange.minRound,
      epochBoundaryRound: boundaryRound,
      roundsCompleted: elapsedDelayRounds,
      roundsToNextEpoch: remainingDelayRounds,
    };
  }

  /**
   * Build progress for STALE state
   */
  private buildStaleProgress(staleness: { reason: string | null }): EpochProgressInfo {
    return {
      phase: 'stale',
      value: null,
      percentage: null,
      explanation: staleness.reason || 'Indexer is stale, progress unavailable',
      currentRound: null,
      epochStartRound: null,
      epochBoundaryRound: null,
      roundsCompleted: null,
      roundsToNextEpoch: null,
    };
  }

  /**
   * Build best-effort progress when precompile unavailable
   */
  private async buildBestEffortProgress(epochId: number): Promise<EpochProgressInfo> {
    try {
      const currentRound = await this.getCurrentRoundInfo();
      const boundary = this.calculateEpochBoundary(epochId);
      
      const roundsCompleted = currentRound.round - (boundary.boundaryRound - this.epochInterval);
      const progressValue = roundsCompleted / this.epochInterval;

      return {
        phase: 'normal',
        value: Math.min(1, Math.max(0, progressValue)),
        percentage: Math.min(100, Math.max(0, progressValue * 100)),
        explanation: `Best-effort progress (precompile unavailable): estimated ${roundsCompleted} rounds completed`,
        currentRound: currentRound.round,
        epochStartRound: boundary.boundaryRound - this.epochInterval,
        epochBoundaryRound: boundary.boundaryRound,
        roundsCompleted,
        roundsToNextEpoch: boundary.boundaryRound - currentRound.round,
      };
    } catch (error) {
      return {
        phase: 'stale',
        value: null,
        percentage: null,
        explanation: 'Progress unavailable (precompile and DB unavailable)',
        currentRound: null,
        epochStartRound: null,
        epochBoundaryRound: null,
        roundsCompleted: null,
        roundsToNextEpoch: null,
      };
    }
  }

  /**
   * Build delay configuration
   */
  private async buildDelayConfig(inDelay: boolean, currentRound: RoundBlockInfo | null): Promise<DelayConfig> {
    const configuredDelayRounds = this.config.getDelayPeriodRounds();
    
    if (!inDelay || !currentRound) {
      return {
        configuredDelayRounds,
        elapsedDelayRounds: null,
        remainingDelayRounds: null,
        delayProgressPercentage: null,
      };
    }

    const epochId = await this.estimateEpochFromDb();
    const boundary = this.calculateEpochBoundary(epochId);
    
    const elapsedDelayRounds = currentRound.round - boundary.delayStartRound;
    const remainingDelayRounds = boundary.delayEndRound - currentRound.round;
    const delayProgressPercentage = (elapsedDelayRounds / configuredDelayRounds) * 100;

    return {
      configuredDelayRounds,
      elapsedDelayRounds,
      remainingDelayRounds,
      delayProgressPercentage,
    };
  }

  /**
   * Get epoch round range from DB
   */
  private async getEpochRoundRange(epochId: number): Promise<{ minRound: number; maxRound: number }> {
    // Get latest round by timestamp (rounds progress independently of epoch)
    const maxQuery = `
      SELECT 
        round
      FROM monad_analytics.block_proposals
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    const maxResult = await this.clickhouse.query({
      query: maxQuery,
      format: 'JSONEachRow',
    });

    const maxRows = await maxResult.json() as Array<{
      round: string;
    }>;

    let maxRound: number;
    if (maxRows.length === 0) {
      // Fallback: use block-based calculation
      maxRound = epochId * this.epochInterval - 1;
    } else {
      maxRound = parseInt(maxRows[0].round);
    }

    // Get minRound for this epoch (for display purposes)
    const minQuery = `
      SELECT 
        round
      FROM monad_analytics.block_proposals
      WHERE epoch = ${epochId}
      ORDER BY timestamp ASC
      LIMIT 1
    `;

    const minResult = await this.clickhouse.query({
      query: minQuery,
      format: 'JSONEachRow',
    });

    const minRows = await minResult.json() as Array<{
      round: string;
    }>;

    let minRound: number;
    if (minRows.length === 0) {
      // Fallback: use block-based calculation
      minRound = (epochId - 1) * this.epochInterval;
    } else {
      minRound = parseInt(minRows[0].round);
    }

    return {
      minRound,
      maxRound,
    };
  }

  /**
   * Get current round information from DB
   */
  private async getCurrentRoundInfo(): Promise<RoundBlockInfo> {
    const query = `
      SELECT 
        round,
        seq_num,
        timestamp,
        epoch
      FROM monad_analytics.block_proposals
      ORDER BY seq_num DESC
      LIMIT 1
    `;

    const result = await this.clickhouse.query({
      query,
      format: 'JSONEachRow',
    });

    const rows = await result.json() as Array<{
      round: string;
      seq_num: string;
      timestamp: string;
      epoch: string;
    }>;

    if (rows.length === 0) {
      throw new Error('No round data available in database');
    }

    return {
      round: parseInt(rows[0].round),
      seq_num: parseInt(rows[0].seq_num),
      timestamp: new Date(rows[0].timestamp),
      epoch: parseInt(rows[0].epoch),
    };
  }

  /**
   * Calculate epoch boundary information
   */
  private calculateEpochBoundary(epochId: number): EpochBoundary {
    const delayRounds = this.config.getDelayPeriodRounds();
    
    // Boundary round is at the end of the epoch
    const boundaryRound = epochId * this.epochInterval;
    
    // Delay starts right after boundary
    const delayStartRound = boundaryRound;
    const delayEndRound = boundaryRound + delayRounds;
    
    // Next epoch starts after delay
    const nextEpochStartRound = delayEndRound;

    return {
      epochId,
      boundaryRound,
      delayStartRound,
      delayEndRound,
      nextEpochStartRound,
    };
  }

  /**
   * Estimate epoch from DB (fallback when precompile unavailable)
   */
  private async estimateEpochFromDb(): Promise<number> {
    const currentRound = await this.getCurrentRoundInfo();
    
    // Use stored epoch if available
    if (currentRound.epoch > 0) {
      return currentRound.epoch;
    }
    
    // Otherwise estimate from round number
    return Math.floor(currentRound.round / this.epochInterval);
  }

  /**
   * Get epoch interval
   */
  getEpochInterval(): number {
    return this.epochInterval;
  }

  /**
   * Force recompute ABT
   */
  async recomputeAbt(): Promise<void> {
    this.abtCalculator.clearCache();
    await this.abtCalculator.computeAbt(true);
  }

  /**
   * Check if system is healthy (precompile + DB available)
   */
  async isHealthy(): Promise<boolean> {
    try {
      const precompileOk = await this.precompileClient.isAvailable();
      const stalenessOk = !(await this.stalenessDetector.isStale());
      
      return precompileOk && stalenessOk;
    } catch {
      return false;
    }
  }
}
