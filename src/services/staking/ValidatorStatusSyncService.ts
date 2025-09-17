// Validator Status Synchronization Background Service
import { StakingPrecompileService, StakingValidator } from './StakingPrecompileService';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';
import cron from 'node-cron';

/**
 * Validator Status Update Event
 */
export interface ValidatorStatusUpdate {
  validatorId: string;
  previousStatus: 'active' | 'inactive' | 'unknown';
  currentStatus: 'active' | 'inactive';
  epoch: number;
  timestamp: Date;
  stakingData: StakingValidator;
}

/**
 * Background service that synchronizes validator status from staking precompile
 * 
 * Features:
 * - Monitors epoch changes
 * - Updates database with latest validator status
 * - Caches validator data for fast API responses
 * - Detects and logs status changes
 * - Runs on configurable schedule
 */
export class ValidatorStatusSyncService {
  private stakingService: StakingPrecompileService;
  private clickhouseClient: MonadClickHouseClient;
  private redisClient: MonadRedisClient;
  private isRunning = false;
  private syncInterval: NodeJS.Timeout | null = null;
  private lastSyncEpoch = 0;

  // Cache keys
  private static readonly CACHE_KEYS = {
    ACTIVE_VALIDATORS: 'staking:validators:active',
    INACTIVE_VALIDATORS: 'staking:validators:inactive',
    VALIDATOR_STATS: 'staking:stats',
    LAST_SYNC_EPOCH: 'staking:last_sync_epoch'
  };

  constructor(
    stakingService: StakingPrecompileService,
    clickhouseClient: MonadClickHouseClient,
    redisClient: MonadRedisClient
  ) {
    this.stakingService = stakingService;
    this.clickhouseClient = clickhouseClient;
    this.redisClient = redisClient;
  }

  /**
   * Start the background sync service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('ValidatorStatusSyncService is already running');
      return;
    }

    try {
      logger.info('🚀 Starting ValidatorStatusSyncService...');
      
      // Initialize staking service
      await this.stakingService.initialize();
      
      // Get last sync epoch from cache
      const cachedEpoch = await this.redisClient['client'].get(ValidatorStatusSyncService.CACHE_KEYS.LAST_SYNC_EPOCH);
      this.lastSyncEpoch = cachedEpoch ? parseInt(cachedEpoch) : 0;
      
      // Perform initial sync
      await this.performSync();
      
      // Schedule regular syncs every 2 minutes
      this.syncInterval = setInterval(async () => {
        try {
          await this.performSync();
        } catch (error) {
          logger.error('Scheduled sync failed:', error);
        }
      }, 120000); // 2 minutes
      
      // Also run on epoch changes (every 10 minutes in cron format)
      cron.schedule('*/10 * * * *', async () => {
        try {
          await this.checkEpochChanges();
        } catch (error) {
          logger.error('Epoch change check failed:', error);
        }
      });
      
      this.isRunning = true;
      logger.info('✅ ValidatorStatusSyncService started successfully');
    } catch (error) {
      logger.error('Failed to start ValidatorStatusSyncService:', error);
      throw error;
    }
  }

  /**
   * Stop the background sync service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('🛑 Stopping ValidatorStatusSyncService...');
    
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    
    this.isRunning = false;
    logger.info('✅ ValidatorStatusSyncService stopped');
  }

  /**
   * Check for epoch changes and trigger sync if needed
   */
  private async checkEpochChanges(): Promise<void> {
    try {
      const epochInfo = await this.stakingService.getCurrentEpoch();
      
      if (epochInfo.epoch !== this.lastSyncEpoch) {
        logger.info(`📊 Epoch changed from ${this.lastSyncEpoch} to ${epochInfo.epoch}, triggering validator sync`);
        await this.performSync();
      }
    } catch (error) {
      logger.error('Failed to check epoch changes:', error);
    }
  }

  /**
   * Perform full validator status synchronization
   */
  private async performSync(): Promise<void> {
    const startTime = Date.now();
    logger.info('🔄 Starting validator status sync...');

    try {
      // Get all validators with their status
      const validatorsData = await this.stakingService.getAllValidatorsWithStatus();
      const epochInfo = await this.stakingService.getCurrentEpoch();
      
      // Update database
      await this.updateValidatorDatabase(validatorsData, epochInfo.epoch);
      
      // Update cache
      await this.updateValidatorCache(validatorsData, epochInfo);
      
      // Store sync epoch
      this.lastSyncEpoch = epochInfo.epoch;
      await this.redisClient['client'].set(
        ValidatorStatusSyncService.CACHE_KEYS.LAST_SYNC_EPOCH, 
        epochInfo.epoch.toString(),
        'EX',
        3600 // 1 hour expiry
      );
      
      const duration = Date.now() - startTime;
      logger.info(`✅ Validator sync completed in ${duration}ms - Active: ${validatorsData.active.length}, Inactive: ${validatorsData.inactive.length}`);
    } catch (error) {
      logger.error('Validator sync failed:', error);
      throw error;
    }
  }

  /**
   * Update validator data in ClickHouse database
   */
  private async updateValidatorDatabase(
    validatorsData: { active: StakingValidator[]; inactive: StakingValidator[]; total: number },
    epoch: number
  ): Promise<void> {
    try {
      const allValidators = [...validatorsData.active, ...validatorsData.inactive];
      
      if (allValidators.length === 0) {
        logger.warn('No validators to update in database');
        return;
      }

      // Prepare data for insertion - update validator_registry table
      const insertData = allValidators.map(validator => ({
        validator_id: validator.validatorId,
        validator_name: `Validator ${validator.validatorId}`, // Could be enhanced with actual names
        stake: validator.stake,
        epoch: epoch,
        is_active: validator.isActive ? 1 : 0,
        is_in_consensus_set: validator.isInConsensusSet ? 1 : 0,
        is_in_snapshot_set: validator.isInSnapshotSet ? 1 : 0,
        is_in_execution_set: validator.isInExecutionSet ? 1 : 0,
        auth_address: validator.authAddress,
        commission: validator.commission,
        consensus_stake: validator.consensusStake,
        flags: validator.flags,
        secp_pubkey: validator.secpPubkey,
        bls_pubkey: validator.blsPubkey,
        last_updated: new Date().toISOString(),
        provider: 'unknown', // Could be enhanced with provider detection
        location: 'unknown'  // Could be enhanced with location detection
      }));

      // Insert new records (ClickHouse will handle duplicates based on ReplacingMergeTree)
      // Use executeRawQuery with escaped values to prevent SQL injection
      const escapeString = (str: string) => str.replace(/'/g, "''").replace(/\\/g, '\\\\');
      
      const values = insertData.map(row => 
        `('${escapeString(row.validator_id)}', '${escapeString(row.validator_name)}', '${escapeString(row.stake)}', ${row.epoch}, ${row.is_active}, ${row.is_in_consensus_set}, ${row.is_in_snapshot_set}, ${row.is_in_execution_set}, '${escapeString(row.auth_address)}', '${escapeString(row.commission)}', '${escapeString(row.consensus_stake)}', ${row.flags}, '${escapeString(row.secp_pubkey)}', '${escapeString(row.bls_pubkey)}', '${escapeString(row.last_updated)}', '${escapeString(row.provider)}', '${escapeString(row.location)}')`
      ).join(',');
      
      const insertQuery = `
        INSERT INTO validator_registry (
          validator_id, validator_name, stake, epoch, is_active, is_in_consensus_set, 
          is_in_snapshot_set, is_in_execution_set, auth_address, commission, 
          consensus_stake, flags, secp_pubkey, bls_pubkey, last_updated, provider, location
        ) VALUES ${values}
      `;
      
      await this.clickhouseClient.executeRawQuery(insertQuery);
      
      logger.info(`📊 Updated ${insertData.length} validators in database for epoch ${epoch}`);
    } catch (error) {
      logger.error('Failed to update validator database:', error);
      throw error;
    }
  }

  /**
   * Update validator data in Redis cache
   */
  private async updateValidatorCache(
    validatorsData: { active: StakingValidator[]; inactive: StakingValidator[]; total: number },
    epochInfo: { epoch: number; inEpochDelayPeriod: boolean }
  ): Promise<void> {
    try {
      const cacheExpiry = 300; // 5 minutes
      
      // Cache active validators
      await this.redisClient['client'].setex(
        ValidatorStatusSyncService.CACHE_KEYS.ACTIVE_VALIDATORS,
        cacheExpiry,
        JSON.stringify(validatorsData.active)
      );
      
      // Cache inactive validators
      await this.redisClient['client'].setex(
        ValidatorStatusSyncService.CACHE_KEYS.INACTIVE_VALIDATORS,
        cacheExpiry,
        JSON.stringify(validatorsData.inactive)
      );
      
      // Cache validator statistics
      const stats = {
        totalValidators: validatorsData.total,
        activeValidators: validatorsData.active.length,
        inactiveValidators: validatorsData.inactive.length,
        currentEpoch: epochInfo.epoch,
        inEpochDelayPeriod: epochInfo.inEpochDelayPeriod,
        lastUpdated: new Date().toISOString()
      };
      
      await this.redisClient['client'].setex(
        ValidatorStatusSyncService.CACHE_KEYS.VALIDATOR_STATS,
        cacheExpiry,
        JSON.stringify(stats)
      );
      
      logger.info('📦 Updated validator cache successfully');
    } catch (error) {
      logger.error('Failed to update validator cache:', error);
      // Don't throw - cache failure shouldn't stop the sync
    }
  }

  /**
   * Get cached active validators
   */
  async getCachedActiveValidators(): Promise<StakingValidator[] | null> {
    try {
      const cached = await this.redisClient['client'].get(ValidatorStatusSyncService.CACHE_KEYS.ACTIVE_VALIDATORS);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.error('Failed to get cached active validators:', error);
      return null;
    }
  }

  /**
   * Get cached inactive validators
   */
  async getCachedInactiveValidators(): Promise<StakingValidator[] | null> {
    try {
      const cached = await this.redisClient['client'].get(ValidatorStatusSyncService.CACHE_KEYS.INACTIVE_VALIDATORS);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.error('Failed to get cached inactive validators:', error);
      return null;
    }
  }

  /**
   * Get cached validator statistics
   */
  async getCachedValidatorStats(): Promise<any | null> {
    try {
      const cached = await this.redisClient['client'].get(ValidatorStatusSyncService.CACHE_KEYS.VALIDATOR_STATS);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.error('Failed to get cached validator stats:', error);
      return null;
    }
  }

  /**
   * Force a manual sync
   */
  async forceSync(): Promise<void> {
    logger.info('🔄 Manual validator sync triggered');
    await this.performSync();
  }

  /**
   * Get service status
   */
  getStatus(): {
    isRunning: boolean;
    lastSyncEpoch: number;
    hasInterval: boolean;
  } {
    return {
      isRunning: this.isRunning,
      lastSyncEpoch: this.lastSyncEpoch,
      hasInterval: this.syncInterval !== null
    };
  }
}
