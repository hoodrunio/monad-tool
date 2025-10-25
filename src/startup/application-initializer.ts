/**
 * Application Initializer
 * 
 * Main startup orchestrator that ensures all critical dependencies are met
 * before starting the Monad Validator Analytics system.
 * 
 */

import { ServiceContainer, ServiceContainerConfig } from '../services/service-container';
import { logger } from '../utils/logger';
import { EpochService } from '../services/epoch/EpochService';
import { NodeRpcClient } from '../services/blockchain/NodeRpcClient';
import { LogEpochDetector } from '../services/epoch/LogEpochDetector';

export interface StartupConfig {
  clickhouse: ServiceContainerConfig['clickhouse'];
  redis: ServiceContainerConfig['redis'];
  skipValidatorCheck?: boolean; // For development only
  maxStartupTimeoutMs?: number;
}

export interface StartupResult {
  success: boolean;
  timeMs: number;
  validatorStats: {
    totalValidators: number;
    validatorsWithLocation: number;
    completionRate: number;
  };
  services: {
    clickhouse: boolean;
    validatorService: boolean;
    locationService: boolean;
  };
  errors: string[];
}

export class ApplicationInitializer {
  private serviceContainer: ServiceContainer;
  private startupConfig: StartupConfig;

  constructor(config: StartupConfig) {
    this.startupConfig = config;
    
    // Get existing ServiceContainer instance (should already be initialized)
    this.serviceContainer = ServiceContainer.getInstance();
  }

  /**
   * MAIN STARTUP METHOD
   * 
   * This method MUST complete successfully before any log processing begins.
   * It ensures the system has all required validator data in the database.
   */
  async initialize(): Promise<StartupResult> {
    const startTime = Date.now();
    const result: StartupResult = {
      success: false,
      timeMs: 0,
      validatorStats: {
        totalValidators: 0,
        validatorsWithLocation: 0,
        completionRate: 0
      },
      services: {
        clickhouse: false,
        validatorService: false,
        locationService: false
      },
      errors: []
    };

    logger.info('🚀 Starting Monad Validator Analytics System...');
    logger.info('⚠️  CRITICAL: System will NOT start without proper validator data in database');

    try {
      // =============================================
      // PHASE 1: VERIFY SERVICE CONTAINER
      // =============================================
      
      logger.info('📊 Phase 1: Verifying service container...');
      if (!this.serviceContainer.initialized) {
        throw new Error('Service container not initialized - this should not happen');
      }
      result.services.clickhouse = true;
      result.services.validatorService = true;
      result.services.locationService = true;
      logger.info('✅ Service container verified');

      // --- DYNAMIC EPOCH & DB SYNC ---
      try {
        logger.info('🔧 Determining current epoch and synchronizing validator registry...');
        const rpcUrl = process.env.RPC_URL;
        if (!rpcUrl) {
          throw new Error('RPC_URL environment variable is not set.');
        }
        const rpcClient = new NodeRpcClient(rpcUrl);
        const epochService = new EpochService(rpcClient);
        const validatorService = this.serviceContainer.getValidatorService();
        const clickhouseClient = this.serviceContainer.getClickHouseClient();

        await clickhouseClient.ensureValidatorRegistryAuthColumns();

        // 1. Determine and set the correct epoch with database fallback
        let actualCurrentEpoch = await epochService.getCurrentEpoch();

        // FALLBACK: If RPC returns a very low epoch (chain halted), use epoch from live logs
        if (actualCurrentEpoch < 10) {
          logger.warn(`⚠️  RPC returned low epoch (${actualCurrentEpoch}), checking for fallback epoch...`);

          // PRIORITY 1: Try to detect epoch from live consensus logs (most reliable)
          try {
            const logDetector = new LogEpochDetector();
            const logEpoch = await logDetector.detectEpoch();

            if (logEpoch && logEpoch > actualCurrentEpoch) {
              logger.info(`📊 Using epoch ${logEpoch} from live logs instead of RPC epoch ${actualCurrentEpoch}`);
              actualCurrentEpoch = logEpoch;
            }
          } catch (error) {
            logger.warn('Could not detect epoch from live logs', error);
          }

          // PRIORITY 2: Try database if logs failed
          if (actualCurrentEpoch < 10) {
            try {
              const dbEpochQuery = await clickhouseClient.executeRawQuery(
                'SELECT MAX(epoch) as max_epoch FROM validator_registry'
              );

              if (dbEpochQuery && dbEpochQuery.length > 0 && dbEpochQuery[0].max_epoch) {
                const dbEpoch = Number(dbEpochQuery[0].max_epoch);
                if (dbEpoch > actualCurrentEpoch) {
                  logger.info(`📊 Using database epoch ${dbEpoch} instead of RPC epoch ${actualCurrentEpoch}`);
                  actualCurrentEpoch = dbEpoch;
                }
              }
            } catch (error) {
              logger.warn('Could not fetch epoch from database', error);
            }
          }

          // PRIORITY 3: Try validator registry as last resort
          if (actualCurrentEpoch < 10) {
            try {
              const availableEpochs = validatorService.getAvailableEpochs();
              if (availableEpochs && availableEpochs.length > 0) {
                const maxEpoch = Math.max(...availableEpochs);
                logger.info(`📊 Using validator registry epoch ${maxEpoch} instead of RPC epoch ${actualCurrentEpoch}`);
                actualCurrentEpoch = maxEpoch;
              }
            } catch (error) {
              logger.warn('Could not fetch epoch from validator registry', error);
            }
          }
        }

        validatorService.setCurrentEpoch(actualCurrentEpoch);
        logger.info(`✅ Current epoch set to ${actualCurrentEpoch} from RPC.`);

        // 2. Get the full, enriched validator list for that epoch
        const validators = await validatorService.getAllValidators(actualCurrentEpoch);

        // 3. Synchronize the database with this fresh data
        await clickhouseClient.updateValidatorRegistry(validators);
        logger.info('✅ Validator registry table synchronized with DB successfully.');

        // 4. Ensure database integrity and clear caches
        await this.ensureDatabaseIntegrity();

      } catch (error) {
        logger.error('🚨 CRITICAL: Failed to determine epoch or synchronize validator DB. Startup cannot continue.', {
          error: error instanceof Error ? error.message : String(error)
        });
        // This is a fatal error, so we re-throw to stop the application startup.
        throw error;
      }
      // --- END DYNAMIC EPOCH & DB SYNC ---

      // =============================================
      // PHASE 2: CRITICAL VALIDATOR & STAKING VALIDATION
      // =============================================
      
      if (!this.startupConfig.skipValidatorCheck) {
        logger.info('🔍 Phase 2: CRITICAL - Validator database validation...');
        logger.info('⏳ This may take a few minutes if validators need to be mapped...');
        
        const databaseValidator = this.serviceContainer.getDatabaseValidator();
        await databaseValidator.ensureValidatorsInDatabase();
        
        // STAKING INITIALIZATION: Align staking flags without touching infrastructure data
        logger.info('🔧 Phase 2b: Synchronizing staking state with database...');
        try {
          const stakingUpdateService = this.serviceContainer.getStakingUpdateService();
          if (stakingUpdateService) {
            await stakingUpdateService.initialize();
            logger.info('✅ Staking update service synchronized with database');
          } else {
            logger.warn('⚠️ StakingUpdateService not available, skipping staking initialization');
          }
        } catch (error) {
          logger.error('Failed to synchronize staking data:', error);
          // Non-fatal error - continue startup but log the issue
        }
        
        // Get final validator stats for result
        const validatorStats = await databaseValidator.getDatabaseValidatorStats();
        result.validatorStats = {
          totalValidators: validatorStats.totalValidators,
          validatorsWithLocation: validatorStats.validatorsWithLocation,
          completionRate: validatorStats.completionRate
        };
        
        logger.info('✅ Validator database validation completed');
        logger.info(`📊 ${validatorStats.totalValidators} validators in database (${validatorStats.completionRate.toFixed(1)}% with location data)`);
      } else {
        logger.warn('⚠️  SKIPPING validator check (development mode)');
      }

      // =============================================
      // PHASE 3: FINAL VALIDATION
      // =============================================

      // =============================================
      // PHASE 3: FINAL VALIDATION
      // =============================================
      
      logger.info('🔍 Phase 3: Final system validation...');
      await this.performFinalValidation();
      logger.info('✅ Final validation completed');

      // =============================================
      // STARTUP COMPLETE
      // =============================================
      
      result.success = true;
      result.timeMs = Date.now() - startTime;
      
      logger.info('🎉 STARTUP SUCCESSFUL!');
      logger.info(`⚡ Total initialization time: ${result.timeMs}ms`);
      logger.info('🔄 System is ready to process validator analytics');
      
      return result;

    } catch (error) {
      result.success = false;
      result.timeMs = Date.now() - startTime;
      result.errors.push(error instanceof Error ? error.message : String(error));
      
      logger.error('❌ STARTUP FAILED:', error);
      logger.error('🚫 System cannot start without proper initialization');
      
      throw new Error(`Application startup failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Quick health check without full initialization
   */
  async healthCheck(): Promise<{
    database: boolean;
    validators: boolean;
    services: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];
    let database = false;
    let validators = false;
    let services = false;

    try {
      // Check if service container is initialized
      if (!this.serviceContainer.initialized) {
        issues.push('Service container not initialized');
        return { database, validators, services, issues };
      }

      // Check database connection
      const clickhouseClient = this.serviceContainer.getClickHouseClient();
      database = await clickhouseClient.ping();
      if (!database) {
        issues.push('Database connection failed');
      }

      // Check validator data
      const databaseValidator = this.serviceContainer.getDatabaseValidator();
      const validatorHealth = await databaseValidator.healthCheck();
      validators = validatorHealth.healthy;
      if (!validators) {
        issues.push(...validatorHealth.issues);
      }

      // Check if services are initialized
      const validatorService = this.serviceContainer.getValidatorService();
      services = validatorService.getStats().totalValidators > 0;
      if (!services) {
        issues.push('Services not properly initialized');
      }

    } catch (error) {
      issues.push(`Health check failed: ${error}`);
    }

    return {
      database,
      validators,
      services,
      issues
    };
  }

  /**
   * Get detailed startup status
   */
  async getStartupStatus(): Promise<{
    ready: boolean;
    validatorStats: any;
    systemHealth: any;
  }> {
    try {
      const databaseValidator = this.serviceContainer.getDatabaseValidator();
      const [validatorStats, healthCheck] = await Promise.all([
        databaseValidator.getDatabaseValidatorStats(),
        this.healthCheck()
      ]);

      return {
        ready: healthCheck.database && healthCheck.validators && healthCheck.services,
        validatorStats,
        systemHealth: healthCheck
      };
    } catch (error) {
      return {
        ready: false,
        validatorStats: null,
        systemHealth: { issues: [`Status check failed: ${error}`] }
      };
    }
  }

  /**
   * Cleanup resources
   */
  async shutdown(): Promise<void> {
    logger.info('🔄 Shutting down application...');
    
    try {
      await this.serviceContainer.shutdown();
      logger.info('✅ Service container shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }

  // ===============================
  // Private Initialization Methods
  // ===============================

  private async performFinalValidation(): Promise<void> {
    // Validate all services are working
    const validatorService = this.serviceContainer.getValidatorService();
    const validatorCount = validatorService.getStats().totalValidators;
    if (validatorCount === 0) {
      throw new Error('ValidatorService has no validators loaded');
    }

    // Test database queries first
    const databaseValidator = this.serviceContainer.getDatabaseValidator();
    const dbStats = await databaseValidator.getDatabaseValidatorStats();
    if (dbStats.totalValidators === 0) {
      throw new Error('No validators found in database after initialization');
    }

    // Check location data availability
    const locationService = this.serviceContainer.getLocationService();
    const locationStats = locationService.getStats();
    
    // If location service cache is empty but database has complete data, use database stats
    if (locationStats.validatorLocationStats.validatorsWithLocation === 0 && dbStats.completionRate === 100) {
      logger.info(`📍 Location data available in database: ${dbStats.totalValidators} validators with ${dbStats.completionRate.toFixed(1)}% location completion`);
    } else {
      logger.info(`📍 Location service: ${locationStats.validatorLocationStats.validatorsWithLocation} validators with location data`);
    }

    logger.info('🔍 Final validation: All systems operational');
  }

  private async ensureDatabaseIntegrity(): Promise<void> {
    logger.info('🔄 Ensuring database integrity and preventing duplicates...');
    const clickhouseClient = this.serviceContainer.getClickHouseClient();

    try {
      // Force table optimization to merge any potential duplicates
      logger.info('🔧 Optimizing validator_registry table to prevent duplicates...');
      await clickhouseClient.executeCommand('OPTIMIZE TABLE validator_registry FINAL');
      
      // Verify table integrity
      const duplicateCheckQuery = `
        SELECT validator_id, COUNT(*) as count
        FROM (
          SELECT DISTINCT validator_id, epoch, last_updated
          FROM validator_registry
          WHERE is_active = 1
        )
        GROUP BY validator_id
        HAVING count > 1
        LIMIT 5
      `;
      
      const duplicateResult = await clickhouseClient.executeRawQuery(duplicateCheckQuery);
      
      if (duplicateResult.length > 0) {
        logger.warn(`⚠️ Found ${duplicateResult.length} validators with potential duplicates, re-optimizing...`);
        await clickhouseClient.executeCommand('OPTIMIZE TABLE validator_registry FINAL');
        logger.info('✅ Table re-optimization completed');
      } else {
        logger.info('✅ No duplicates detected in validator registry');
      }
      
      logger.info('✅ Database integrity check completed');
    } catch (error) {
      logger.warn('Failed to ensure database integrity:', error);
      // Don't throw - this is a best effort optimization
    }
  }

  // ===============================
  // Static Helper Methods
  // ===============================

  /**
   * Create default startup configuration
   */
  static createDefaultConfig(): StartupConfig {
    return {
      clickhouse: {
        host: process.env.CLICKHOUSE_HOST || 'localhost',
        port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
        username: process.env.CLICKHOUSE_USER || 'default',
        password: process.env.CLICKHOUSE_PASSWORD || '',
        database: process.env.CLICKHOUSE_DB || 'monad_analytics',
        max_open_connections: 10,
        max_query_timeout: 30000,
        compression: true
      },
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
        keyPrefix: process.env.REDIS_KEY_PREFIX || 'monad:',
        maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES || '3'),
        retryDelayOnFailover: parseInt(process.env.REDIS_RETRY_DELAY || '1000'),
        maxMemoryPolicy: process.env.REDIS_MEMORY_POLICY || 'allkeys-lru',
        defaultTtl: parseInt(process.env.REDIS_DEFAULT_TTL || '300')
      },
      skipValidatorCheck: process.env.NODE_ENV === 'development' && process.env.SKIP_VALIDATOR_CHECK === 'true',
      maxStartupTimeoutMs: 10 * 60 * 1000 // 10 minutes max startup time
    };
  }

  /**
   * Initialize application with default config
   */
  static async initializeWithDefaults(): Promise<StartupResult> {
    const config = ApplicationInitializer.createDefaultConfig();
    const initializer = new ApplicationInitializer(config);
    
    return await initializer.initialize();
  }
} 
