// Staking Service Manager - Orchestrates all staking-related services
import { StakingPrecompileService } from './StakingPrecompileService';
import { ValidatorStatusSyncService } from './ValidatorStatusSyncService';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

/**
 * Configuration for Staking Services
 */
export interface StakingServiceConfig {
  rpcUrl: string;
  syncIntervalMinutes?: number;
  enableBackgroundSync?: boolean;
}

/**
 * Staking Service Manager
 * 
 * Manages and coordinates all staking-related services:
 * - StakingPrecompileService: Direct interaction with staking precompile
 * - ValidatorStatusSyncService: Background synchronization service
 * - Service lifecycle management
 * - Health monitoring
 */
export class StakingServiceManager {
  private stakingService: StakingPrecompileService;
  private syncService: ValidatorStatusSyncService;
  private config: StakingServiceConfig;
  private isInitialized = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    config: StakingServiceConfig,
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {
    this.config = {
      syncIntervalMinutes: 2,
      enableBackgroundSync: true,
      ...config
    };

    // Initialize services
    this.stakingService = new StakingPrecompileService(config.rpcUrl);
    this.syncService = new ValidatorStatusSyncService(
      this.stakingService,
      this.clickhouseClient,
      this.redisClient
    );
  }

  /**
   * Initialize all staking services
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('StakingServiceManager is already initialized');
      return;
    }

    try {
      logger.info('🚀 Initializing Staking Service Manager...');
      
      // Initialize staking precompile service
      await this.stakingService.initialize();
      logger.info('✅ StakingPrecompileService initialized');

      // Start background sync service if enabled
      if (this.config.enableBackgroundSync) {
        await this.syncService.start();
        logger.info('✅ ValidatorStatusSyncService started');
      }

      // Start health monitoring
      this.startHealthMonitoring();

      this.isInitialized = true;
      logger.info('✅ StakingServiceManager initialization complete');
    } catch (error) {
      logger.error('Failed to initialize StakingServiceManager:', error);
      throw error;
    }
  }

  /**
   * Shutdown all staking services
   */
  async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      logger.info('🛑 Shutting down Staking Service Manager...');

      // Stop health monitoring
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      // Stop sync service
      if (this.config.enableBackgroundSync) {
        await this.syncService.stop();
        logger.info('✅ ValidatorStatusSyncService stopped');
      }

      this.isInitialized = false;
      logger.info('✅ StakingServiceManager shutdown complete');
    } catch (error) {
      logger.error('Error during StakingServiceManager shutdown:', error);
      throw error;
    }
  }

  /**
   * Get the staking precompile service instance
   */
  getStakingService(): StakingPrecompileService {
    if (!this.isInitialized) {
      throw new Error('StakingServiceManager not initialized');
    }
    return this.stakingService;
  }

  /**
   * Get the validator sync service instance
   */
  getSyncService(): ValidatorStatusSyncService {
    if (!this.isInitialized) {
      throw new Error('StakingServiceManager not initialized');
    }
    return this.syncService;
  }

  /**
   * Get service health status
   */
  async getHealthStatus(): Promise<{
    isHealthy: boolean;
    services: {
      stakingService: {
        initialized: boolean;
        currentEpoch?: number;
        lastError?: string;
      };
      syncService: {
        running: boolean;
        lastSyncEpoch: number;
        hasInterval: boolean;
        lastError?: string;
      };
    };
    lastHealthCheck: string;
  }> {
    const status = {
      isHealthy: true,
      services: {
        stakingService: {
          initialized: this.isInitialized,
          currentEpoch: undefined as number | undefined,
          lastError: undefined as string | undefined
        },
        syncService: {
          running: false,
          lastSyncEpoch: 0,
          hasInterval: false,
          lastError: undefined as string | undefined
        }
      },
      lastHealthCheck: new Date().toISOString()
    };

    try {
      // Check staking service health
      if (this.isInitialized) {
        const epochInfo = await this.stakingService.getCurrentEpoch();
        status.services.stakingService.currentEpoch = epochInfo.epoch;
      }
    } catch (error) {
      status.isHealthy = false;
      status.services.stakingService.lastError = error instanceof Error ? error.message : String(error);
    }

    try {
      // Check sync service health
      if (this.config.enableBackgroundSync) {
        const syncStatus = this.syncService.getStatus();
        status.services.syncService = {
          running: syncStatus.isRunning,
          lastSyncEpoch: syncStatus.lastSyncEpoch,
          hasInterval: syncStatus.hasInterval,
          lastError: undefined
        };
      }
    } catch (error) {
      status.isHealthy = false;
      status.services.syncService.lastError = error instanceof Error ? error.message : String(error);
    }

    return status;
  }

  /**
   * Force a manual validator sync
   */
  async forceSyncValidators(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('StakingServiceManager not initialized');
    }

    await this.syncService.forceSync();
  }

  /**
   * Get comprehensive staking statistics
   */
  async getStakingStatistics(): Promise<{
    validators: {
      total: number;
      active: number;
      inactive: number;
    };
    sets: {
      consensus: number;
      execution: number;
      snapshot: number;
    };
    epoch: {
      current: number;
      inDelayPeriod: boolean;
    };
    cache: {
      hasActiveValidators: boolean;
      hasInactiveValidators: boolean;
      hasStats: boolean;
    };
  }> {
    if (!this.isInitialized) {
      throw new Error('StakingServiceManager not initialized');
    }

    const [stakingStats, epochInfo, cachedActive, cachedInactive, cachedStats] = await Promise.all([
      this.stakingService.getValidatorStats(),
      this.stakingService.getCurrentEpoch(),
      this.syncService.getCachedActiveValidators(),
      this.syncService.getCachedInactiveValidators(),
      this.syncService.getCachedValidatorStats()
    ]);

    return {
      validators: {
        total: stakingStats.totalValidators,
        active: stakingStats.activeValidators,
        inactive: stakingStats.inactiveValidators
      },
      sets: {
        consensus: stakingStats.consensusSetSize,
        execution: stakingStats.executionSetSize,
        snapshot: stakingStats.snapshotSetSize
      },
      epoch: {
        current: epochInfo.epoch,
        inDelayPeriod: epochInfo.inEpochDelayPeriod
      },
      cache: {
        hasActiveValidators: cachedActive !== null,
        hasInactiveValidators: cachedInactive !== null,
        hasStats: cachedStats !== null
      }
    };
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    // Check health every 5 minutes
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.getHealthStatus();
        if (!health.isHealthy) {
          logger.warn('🔴 Staking services health check failed:', health);
        } else {
          logger.debug('🟢 Staking services health check passed');
        }
      } catch (error) {
        logger.error('Health check error:', error);
      }
    }, 300000); // 5 minutes
  }

  /**
   * Get manager status
   */
  getStatus(): {
    initialized: boolean;
    enableBackgroundSync: boolean;
    hasHealthMonitoring: boolean;
  } {
    return {
      initialized: this.isInitialized,
      enableBackgroundSync: this.config.enableBackgroundSync || false,
      hasHealthMonitoring: this.healthCheckInterval !== null
    };
  }
}
