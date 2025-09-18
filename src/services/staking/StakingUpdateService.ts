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
   * Main update logic
   */
  private async performUpdate(): Promise<void> {
    if (this.isUpdating) {
      logger.debug('Update already in progress, skipping...');
      return;
    }

    this.isUpdating = true;

    try {
      // Check if epoch has changed
      const epochChanged = await this.stakingService.hasEpochChanged();
      
      if (!epochChanged) {
        logger.debug('No epoch change detected, skipping update');
        return;
      }

      logger.info('📈 Epoch change detected, updating validator staking info...');

      // Refresh staking information
      await this.stakingService.refreshStakingInfo();
      
      // Update comprehensive validator cache (this does the expensive scanning)
      await this.stakingService.updateComprehensiveValidatorCache();
      
      // Update database
      await this.updateValidatorRegistry();
      
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
   * Update validator_registry table with latest staking data
   */
  private async updateValidatorRegistry(): Promise<void> {
    const stakingInfo = this.stakingService.getStakingInfo();
    if (!stakingInfo) {
      logger.warn('No staking info available for database update');
      return;
    }

    try {
      logger.info('📊 Updating validator registry in database...');

      // First, mark all validators as inactive
      await this.config.clickhouseClient.executeCommand(`
        INSERT INTO validator_registry (
          validator_id,
          node_id,
          epoch,
          stake,
          position,
          is_active,
          validator_name,
          keybase_id,
          keybase_logo_url,
          provider,
          location,
          last_updated
        )
        SELECT 
          validator_id,
          argMax(node_id, last_updated) as node_id,
          ${stakingInfo.currentEpoch} as epoch,
          argMax(stake, last_updated) as stake,
          argMax(position, last_updated) as position,
          0 as is_active,  -- Mark as inactive
          argMax(validator_name, last_updated) as validator_name,
          argMax(keybase_id, last_updated) as keybase_id,
          argMax(keybase_logo_url, last_updated) as keybase_logo_url,
          argMax(provider, last_updated) as provider,
          argMax(location, last_updated) as location,
          now() as last_updated
        FROM validator_registry
        WHERE is_active = 1
        GROUP BY validator_id
      `);

      // Then insert/update ALL validators with stake (active + inactive)
      // Get comprehensive mapping of precompile validator ID -> secp address
      const validatorMapping = await this.stakingService.getValidatorMappingBySecpAddress();
      
      logger.info(`📊 Updating ${validatorMapping.size} validators (including inactive with stake)`);
      
      for (const [secpAddress, mapping] of validatorMapping.entries()) {
        const validatorId = mapping.validatorId;
        const stake = mapping.stake;

        // Get existing validator info to preserve metadata
        const existingValidatorQuery = `
          SELECT 
            argMax(validator_name, last_updated) as validator_name,
            argMax(provider, last_updated) as provider,
            argMax(location, last_updated) as location,
            argMax(keybase_id, last_updated) as keybase_id,
            argMax(keybase_logo_url, last_updated) as keybase_logo_url,
            argMax(position, last_updated) as position
          FROM validator_registry
          WHERE validator_id = '${secpAddress}'
          GROUP BY validator_id
        `;

        const existingData = await this.config.clickhouseClient.executeRawQuery(existingValidatorQuery);
        const existing = existingData[0] || {};

        // Insert updated validator record with proper column specification
        await this.config.clickhouseClient.executeCommand(`
          INSERT INTO validator_registry (
            validator_id,
            node_id,
            epoch,
            stake,
            position,
            is_active,
            validator_name,
            keybase_id,
            keybase_logo_url,
            provider,
            location,
            last_updated
          ) VALUES (
            '${secpAddress}',  -- Keep secp address as validator_id for database consistency
            '${validatorId}',  -- Store precompile validator ID as node_id for future reference
            ${stakingInfo.currentEpoch},
            ${stake.toString()},
            ${existing.position || 0},  -- Preserve existing position
            ${mapping.isActive ? 1 : 0},  -- Active status from precompile
            '${existing.validator_name || 'unknown'}',
            '${existing.keybase_id || ''}',
            '${existing.keybase_logo_url || ''}',
            '${existing.provider || 'unknown'}',
            '${existing.location || 'unknown'}',
            now()
          )
        `);
      }

      // Optimize table to merge records
      await this.config.clickhouseClient.executeCommand('OPTIMIZE TABLE validator_registry FINAL');
      
      logger.info(`✅ Updated ${validatorMapping.size} active validators in database`);
    } catch (error) {
      logger.error('Failed to update validator registry:', error);
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
   * Get secp addresses for active validators (for database matching)
   */
  async getActiveValidatorSecpAddresses(): Promise<string[]> {
    return this.stakingService.getActiveValidatorSecpAddresses();
  }

  /**
   * Get mapping of secp address to validator info (for enriching database results)
   */
  async getValidatorMappingBySecpAddress(): Promise<Map<string, {validatorId: string, stake: bigint, isActive: boolean}>> {
    return this.stakingService.getValidatorMappingBySecpAddress();
  }

  /**
   * Initialize validator mappings from database (one-time setup)
   */
  async initializeValidatorMappings(): Promise<void> {
    await this.stakingService.loadValidatorMappingsFromDatabase(this.config.clickhouseClient);
  }
}
