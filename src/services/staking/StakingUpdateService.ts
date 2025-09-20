import { StakingService } from './StakingService';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export interface StakingUpdateConfig {
  updateIntervalMs: number; // How often to check for epoch changes
  rpcUrl: string;
  clickhouseClient: MonadClickHouseClient;
  redisClient: MonadRedisClient;
}

/**
 * StakingUpdateService
 */
export class StakingUpdateService {
  private stakingService: StakingService;
  private config: StakingUpdateConfig;
  private updateTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isUpdating = false;

  constructor(config: StakingUpdateConfig) {
    this.config = config;
    this.stakingService = new StakingService(config.rpcUrl);
  }

  async initialize(): Promise<void> {
    try {
      logger.info('🔧 Initializing Staking Update Service...');
      
      await this.stakingService.initialize();

      // Ensure database snapshot matches current consensus set on startup
      try {
        await this.stakingService.updateValidatorsIncrementally(this.config.clickhouseClient);
        logger.info('✅ Initial staking snapshot synchronized with database');
      } catch (syncError) {
        logger.warn('Failed to synchronize initial staking snapshot:', syncError);
      }
      
      logger.info('✅ Staking Update Service initialized');
    } catch (error) {
      logger.error('Failed to initialize StakingUpdateService:', error);
      throw error;
    }
  }

  /**
   * Start the background update service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Staking update service is already running');
      return;
    }

    this.isRunning = true;
    logger.info(`🚀 Starting staking update service with ${this.config.updateIntervalMs}ms interval`);

    // Run initial update
    this.performUpdate().catch(error => {
      logger.error('Initial staking update failed:', error);
    });

    // Setup periodic updates
    this.updateTimer = setInterval(async () => {
      try {
        await this.performUpdate();
      } catch (error) {
        logger.error('Periodic staking update failed:', error);
      }
    }, this.config.updateIntervalMs);
  }

  /**
   * Stop the background update service
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    logger.info('🛑 Staking update service stopped');
  }

  /**
   * Force an immediate update
   */
  async forceUpdate(): Promise<void> {
    logger.info('🔄 Forcing staking update...');
    await this.performUpdate();
  }

  /**
   * Force a full synchronization regardless of epoch changes
   */
  async forceFullSync(): Promise<void> {
    logger.info('🔁 Forcing full staking synchronization...');
    await this.performUpdate({ skipEpochCheck: true });
  }

  /**
   * Main update logic - REFACTORED for database-first approach
   */
  private async performUpdate(options: { skipEpochCheck?: boolean } = {}): Promise<void> {
    const { skipEpochCheck = false } = options;

    if (this.isUpdating) {
      logger.debug('Update already in progress, skipping...');
      return;
    }

    this.isUpdating = true;

    try {
      logger.info('🔍 Checking for epoch changes every 30s...');

      let shouldUpdate = skipEpochCheck;

      if (!shouldUpdate) {
        // Check if epoch has changed
        const epochChanged = await this.stakingService.hasEpochChanged();
        shouldUpdate = epochChanged;

        if (!epochChanged) {
          logger.info('✅ No epoch change detected - current system is running correctly');
        } else {
          logger.info('📈 Epoch change detected, updating validator staking info...');
        }
      } else {
        logger.info('⚙️ Skipping epoch change check - manual resynchronization requested');
      }

      if (!shouldUpdate) {
        return;
      }

      // Refresh staking information from precompile
      await this.stakingService.refreshStakingInfo();
      
      // DATABASE-FIRST: Update validators incrementally
      await this.stakingService.updateValidatorsIncrementally(this.config.clickhouseClient);

      // Ensure any legacy rows missing identifiers are backfilled
      await this.stakingService.backfillMissingPrecompileIds(this.config.clickhouseClient);
      
      // Clear cache
      await this.clearValidatorCache();
      
      logger.info('✅ Staking update completed successfully');
    } catch (error) {
      logger.error('Failed to perform staking update:', error);
      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Add initial population method for startup
   */
  async performInitialPopulation(): Promise<void> {
    logger.info('🚀 Starting initial validator population...');
    
    try {
      // Refresh staking info first
      await this.stakingService.refreshStakingInfo();
      
      // DATABASE-FIRST: Populate all validators to database
      await this.stakingService.populateAllValidatorsToDatabase(this.config.clickhouseClient);
      
      logger.info('✅ Initial population completed successfully');
    } catch (error) {
      logger.error('Failed to perform initial population:', error);
      throw error;
    }
  }

  /**
   * Clear validator-related cache entries
   */
  private async clearValidatorCache(): Promise<void> {
    try {
      logger.info('🗑️ Clearing validator cache...');
      
      await this.config.redisClient.invalidatePattern('validator_*');
      
      logger.info('✅ Validator cache cleared');
    } catch (error) {
      logger.error('Failed to clear validator cache:', error);
      // Don't throw - cache clearing is not critical
    }
  }

  /**
   * Get current update status
   */
  getStatus(): {
    isRunning: boolean;
    isUpdating: boolean;
    lastStakingInfo: any;
    updateInterval: number;
  } {
    return {
      isRunning: this.isRunning,
      isUpdating: this.isUpdating,
      lastStakingInfo: this.stakingService.getStakingInfo(),
      updateInterval: this.config.updateIntervalMs
    };
  }

  /**
   * Get staking statistics
   */
  getStakingStats() {
    return this.stakingService.getStakingStats();
  }

  /**
   * Check if a validator is active
   */
  isValidatorActive(validatorId: string): boolean {
    return this.stakingService.isValidatorActive(validatorId);
  }

  /**
   * Get validator stake amount
   */
  getValidatorStake(validatorId: string): bigint | null {
    return this.stakingService.getValidatorStake(validatorId);
  }

  /**
   * Get all active validator IDs
   */
  getActiveValidatorIds(): string[] {
    return this.stakingService.getActiveValidatorIds();
  }

  /**
   * DATABASE-FIRST: Get mapping of secp address to validator info from database
   */
  async getValidatorMappingBySecpAddress(): Promise<Map<string, {validatorId: string, stake: bigint, isActive: boolean}>> {
    return this.stakingService.getValidatorMappingBySecpAddress(this.config.clickhouseClient);
  }

  /**
   * Get active validator IDs from current staking info
   */
  async getActiveValidatorSecpAddresses(): Promise<string[]> {
    const mapping = await this.getValidatorMappingBySecpAddress();
    
    return Array.from(mapping.keys()).filter(secpAddress => {
      const validatorData = mapping.get(secpAddress);
      return validatorData?.isActive;
    });
  }
}
