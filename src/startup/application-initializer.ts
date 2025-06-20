/**
 * Application Initializer
 * 
 * Main startup orchestrator that ensures all critical dependencies are met
 * before starting the Monad Validator Analytics system.
 * 
 * CRITICAL STARTUP SEQUENCE:
 * 1. Database Connection & Schema
 * 2. Validator Data Initialization  
 * 3. Service Dependencies
 * 4. Application Start
 */

import { MonadClickHouseClient, ClickHouseConfig } from '../database/clickhouse-client';
import { DatabaseValidatorInitializer } from '../services/database-validator-initializer';
import { ValidatorService } from '../services/unified-validator';
import { UnifiedLocationService } from '../services/unified-location';
import { logger } from '../utils/logger';

export interface StartupConfig {
  clickhouse: ClickHouseConfig;
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
  private clickhouseClient: MonadClickHouseClient;
  private databaseValidator: DatabaseValidatorInitializer;
  private validatorService: ValidatorService;
  private locationService: UnifiedLocationService;
  private startupConfig: StartupConfig;

  constructor(config: StartupConfig) {
    this.startupConfig = config;
    this.clickhouseClient = new MonadClickHouseClient(config.clickhouse);
    this.databaseValidator = new DatabaseValidatorInitializer(this.clickhouseClient);
    this.validatorService = new ValidatorService();
    this.locationService = new UnifiedLocationService();
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
      // PHASE 1: DATABASE CONNECTION & SCHEMA
      // =============================================
      
      logger.info('📊 Phase 1: Initializing database connection...');
      await this.initializeDatabase();
      result.services.clickhouse = true;
      logger.info('✅ Database connection established');

      // =============================================
      // PHASE 2: CRITICAL VALIDATOR VALIDATION
      // =============================================
      
      if (!this.startupConfig.skipValidatorCheck) {
        logger.info('🔍 Phase 2: CRITICAL - Validator database validation...');
        logger.info('⏳ This may take a few minutes if validators need to be mapped...');
        
        await this.databaseValidator.ensureValidatorsInDatabase();
        
        // Get final validator stats for result
        const validatorStats = await this.databaseValidator.getDatabaseValidatorStats();
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
      // PHASE 3: SERVICE INITIALIZATION
      // =============================================
      
      logger.info('🔧 Phase 3: Initializing application services...');
      
      await Promise.all([
        this.validatorService.initialize(),
        this.locationService.initialize()
      ]);
      
      result.services.validatorService = true;
      result.services.locationService = true;
      logger.info('✅ Application services initialized');

      // =============================================
      // PHASE 4: FINAL VALIDATION
      // =============================================
      
      logger.info('🔍 Phase 4: Final system validation...');
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
      // Check database connection
      database = await this.clickhouseClient.ping();
      if (!database) {
        issues.push('Database connection failed');
      }

      // Check validator data
      const validatorHealth = await this.databaseValidator.healthCheck();
      validators = validatorHealth.healthy;
      if (!validators) {
        issues.push(...validatorHealth.issues);
      }

      // Check if services are initialized
      services = this.validatorService.getStats().totalValidators > 0;
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
      const [validatorStats, healthCheck] = await Promise.all([
        this.databaseValidator.getDatabaseValidatorStats(),
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
      await this.clickhouseClient.close();
      logger.info('✅ Database connection closed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }

  // ===============================
  // Private Initialization Methods
  // ===============================

  private async initializeDatabase(): Promise<void> {
    // Test connection
    const connected = await this.clickhouseClient.ping();
    if (!connected) {
      throw new Error('Cannot connect to ClickHouse database');
    }

    // Initialize schema
    await this.clickhouseClient.initializeSchema();
    logger.info('📊 Database schema initialized');
  }

  private async performFinalValidation(): Promise<void> {
    // Validate all services are working
    const validatorCount = this.validatorService.getStats().totalValidators;
    if (validatorCount === 0) {
      throw new Error('ValidatorService has no validators loaded');
    }

    const locationStats = this.locationService.getStats();
    logger.info(`📍 Location service: ${locationStats.validatorLocationStats.validatorsWithLocation} validators with location data`);

    // Test database queries
    const dbStats = await this.databaseValidator.getDatabaseValidatorStats();
    if (dbStats.totalValidators === 0) {
      throw new Error('No validators found in database after initialization');
    }

    logger.info('🔍 Final validation: All systems operational');
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