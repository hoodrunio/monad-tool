// Database-Centric Staking Update Service
// Handles periodic epoch monitoring and incremental validator updates

import { DatabaseStakingService, StakingStats } from './DatabaseStakingService';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export interface StakingUpdateConfig {
  updateIntervalMs: number; // How often to check for epoch changes
  rpcUrl: string;
  clickhouseClient: MonadClickHouseClient;
  redisClient: MonadRedisClient;
}

export class DatabaseStakingUpdateService {
  private stakingService: DatabaseStakingService;
  private config: StakingUpdateConfig;
  private updateTimer: NodeJS.Timeout | null = null;
  private isUpdating = false;
  private isRunning = false;

  constructor(config: StakingUpdateConfig) {
    this.config = config;
    this.stakingService = new DatabaseStakingService(config.rpcUrl, config.clickhouseClient);
  }

  // =============================================
  // LIFECYCLE MANAGEMENT
  // =============================================

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Staking update service is already running');
      return;
    }

    try {
      logger.info('🚀 Starting database staking update service...');
      
      // Initialize staking service
      await this.stakingService.initialize();
      
      // Start periodic updates
      this.isRunning = true;
      this.scheduleNextUpdate();
      
      logger.info(`✅ Database staking update service started (interval: ${this.config.updateIntervalMs}ms)`);
    } catch (error) {
      logger.error('Failed to start staking update service:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('🔄 Stopping database staking update service...');
    
    this.isRunning = false;
    
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    
    // Wait for current update to complete
    while (this.isUpdating) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    logger.info('✅ Database staking update service stopped');
  }

  // =============================================
  // UPDATE SCHEDULING
  // =============================================

  private scheduleNextUpdate(): void {
    if (!this.isRunning) return;

    this.updateTimer = setTimeout(async () => {
      await this.performUpdate();
      this.scheduleNextUpdate();
    }, this.config.updateIntervalMs);
  }

  /**
   * Force an immediate update (for API endpoints)
   */
  async forceUpdate(): Promise<void> {
    logger.info('🔄 Forcing database staking update...');
    await this.performUpdate();
  }

  // =============================================
  // UPDATE LOGIC
  // =============================================

  /**
   * Main update logic - checks for epoch changes and performs incremental updates
   */
  private async performUpdate(): Promise<void> {
    if (this.isUpdating) {
      logger.debug('Update already in progress, skipping...');
      return;
    }

    this.isUpdating = true;

    try {
      logger.info('🔍 Checking for epoch changes every 30s...');
      
      // Check if epoch has changed
      const { changed, currentEpoch, dbEpoch } = await this.stakingService.hasEpochChanged();
      
      if (!changed) {
        logger.info(`✅ No epoch change detected - current system is running correctly (epoch: ${dbEpoch})`);
        return;
      }

      logger.info(`📈 Epoch change detected! DB: ${dbEpoch} → Current: ${currentEpoch}, updating validator staking info...`);

      // Perform incremental update (only new validators + active validator stakes)
      await this.stakingService.performIncrementalUpdate(currentEpoch);
      
      // Clear relevant caches
      await this.clearValidatorCache();
      
      logger.info('✅ Database staking update completed successfully');
    } catch (error) {
      logger.error('Failed to perform staking update:', error);
      // Don't throw - continue with next scheduled update
    } finally {
      this.isUpdating = false;
    }
  }

  // =============================================
  // API LAYER (Database-Only Queries)
  // =============================================

  /**
   * Get staking statistics (from database only)
   */
  async getStakingStats(): Promise<StakingStats | null> {
    try {
      return await this.stakingService.getStakingStatsFromDB();
    } catch (error) {
      logger.error('Failed to get staking stats:', error);
      return null;
    }
  }

  /**
   * Get current service status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isUpdating: this.isUpdating,
      updateIntervalMs: this.config.updateIntervalMs,
      lastUpdate: new Date() // Could be tracked more precisely if needed
    };
  }

  // =============================================
  // CACHE MANAGEMENT
  // =============================================

  /**
   * Clear validator-related cache entries
   */
  private async clearValidatorCache(): Promise<void> {
    try {
      const cacheKeys = [
        'validator_rankings:*',
        'validator_history:*',
        'validator_comparison:*'
      ];

      for (const pattern of cacheKeys) {
        await this.config.redisClient.invalidatePattern(pattern);
      }

      logger.info('✅ Validator cache cleared after staking update');
    } catch (error) {
      logger.warn('Failed to clear validator cache:', error);
      // Non-critical error, don't throw
    }
  }

  // =============================================
  // LEGACY COMPATIBILITY (Database Queries Only)
  // =============================================

  /**
   * Legacy compatibility: Get active validator IDs from database
   */
  async getActiveValidatorIds(): Promise<string[]> {
    try {
      const result = await this.config.clickhouseClient.executeRawQuery(`
        SELECT precompile_validator_id
        FROM validator_registry
        WHERE is_active = 1 
        AND precompile_validator_id != ''
        AND last_updated = (SELECT max(last_updated) FROM validator_registry)
        ORDER BY precompile_validator_id
      `);
      
      return result.map((row: any) => row.precompile_validator_id);
    } catch (error) {
      logger.error('Failed to get active validator IDs from database:', error);
      return [];
    }
  }

  /**
   * Legacy compatibility: Get validator mapping by secp address (database only)
   */
  async getValidatorMappingBySecpAddress(): Promise<Map<string, {validatorId: string, stake: bigint, isActive: boolean}>> {
    const mapping = new Map();
    
    try {
      const result = await this.config.clickhouseClient.executeRawQuery(`
        SELECT 
          validator_id as secp_address,
          precompile_validator_id,
          real_time_stake_wei,
          is_active
        FROM validator_registry
        WHERE precompile_validator_id != ''
        AND last_updated = (SELECT max(last_updated) FROM validator_registry)
        ORDER BY validator_id
      `);
      
      for (const row of result) {
        if (row.secp_address && row.precompile_validator_id) {
          mapping.set(row.secp_address, {
            validatorId: row.precompile_validator_id,
            stake: BigInt(row.real_time_stake_wei || '0'),
            isActive: Boolean(row.is_active)
          });
        }
      }
      
      logger.debug(`🚀 Database validator mapping: ${mapping.size} validators`);
    } catch (error) {
      logger.error('Failed to get validator mapping from database:', error);
    }
    
    return mapping;
  }

  /**
   * Legacy compatibility: Get secp addresses for active validators (database only)
   */
  async getActiveValidatorSecpAddresses(): Promise<string[]> {
    try {
      const result = await this.config.clickhouseClient.executeRawQuery(`
        SELECT validator_id
        FROM validator_registry
        WHERE is_active = 1 
        AND precompile_validator_id != ''
        AND last_updated = (SELECT max(last_updated) FROM validator_registry)
        ORDER BY validator_id
      `);
      
      return result.map((row: any) => row.validator_id);
    } catch (error) {
      logger.error('Failed to get active validator secp addresses from database:', error);
      return [];
    }
  }
}

// Export for backward compatibility
export { DatabaseStakingUpdateService as StakingUpdateService };
