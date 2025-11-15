/**
 * Service Container
 * 
 * Manages singleton instances of services to prevent duplicate initialization
 * and ensure consistent service dependencies across the application.
 */

import { ValidatorService } from './unified-validator';
import { UnifiedLocationService } from './unified-location';
import { MonadClickHouseClient, ClickHouseConfig } from '../database/clickhouse-client';
import { MonadRedisClient, RedisConfig } from '../cache/redis-client';
import { DatabaseValidatorInitializer } from './database-validator-initializer';
import { logger } from '../utils/logger';
import { ProviderPerformanceCacheService } from './provider-performance-cache';
import { StakingUpdateService, StakingUpdateConfig } from './staking/StakingUpdateService';
import { ValidatorInfoUpdateService } from './ValidatorInfoUpdateService';
import { ValidatorInfoRegistry, ValidatorNetwork } from './ValidatorInfoRegistry';
import { MigrationRunner } from '../database/migration-runner';
import { IpcPollingService } from './ipc/IpcPollingService.js';
import { IpcLocationMapper } from './validator-location/mappers/IpcLocationMapper.js';
import dotenv from 'dotenv';

dotenv.config();

export interface ServiceContainerConfig {
  clickhouse: ClickHouseConfig;
  redis: RedisConfig;
}

export class ServiceContainer {
  private static instance: ServiceContainer | null = null;
  
  private _clickhouseClient: MonadClickHouseClient | null = null;
  private _redisClient: MonadRedisClient | null = null;
  private _validatorService: ValidatorService | null = null;
  private _locationService: UnifiedLocationService | null = null;
  private _databaseValidator: DatabaseValidatorInitializer | null = null;
  private _providerCacheService: ProviderPerformanceCacheService | null = null;
  private _stakingUpdateService: StakingUpdateService | null = null;
  private _validatorInfoUpdateService: ValidatorInfoUpdateService | null = null;
  private _ipcPollingService: IpcPollingService | null = null;

  private isInitialized: boolean = false;
  private config: ServiceContainerConfig;

  private constructor(config: ServiceContainerConfig) {
    this.config = config;
  }

  /**
   * Get singleton instance of ServiceContainer
   */
  static getInstance(config?: ServiceContainerConfig): ServiceContainer {
    if (!ServiceContainer.instance) {
      if (!config) {
        throw new Error('ServiceContainer must be initialized with config on first call');
      }
      ServiceContainer.instance = new ServiceContainer(config);
    }
    return ServiceContainer.instance;
  }

  /**
   * Initialize all services in the correct order
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.debug('🔄 ServiceContainer already initialized, skipping...');
      return;
    }

    logger.info('🔧 Initializing ServiceContainer...');

    // Initialize database client
    this._clickhouseClient = new MonadClickHouseClient(this.config.clickhouse);
    await this._clickhouseClient.initializeSchema();

    // Ensure database schema migrations have been applied
    const migrationRunner = new MigrationRunner(this._clickhouseClient);
    await migrationRunner.runMigrationIfNeeded();

    // Initialize Redis client
    this._redisClient = new MonadRedisClient(this.config.redis);

    // Initialize location service first (no dependencies)
    this._locationService = new UnifiedLocationService();
    await this._locationService.initialize();
    
    // Process all validator locations to populate the service with real data
    logger.info('🌍 Processing validator locations...');
    await this._locationService.processAllValidatorLocations();
    logger.info('✅ Validator location processing complete');

    // Initialize validator service with location service and database dependencies
    this._validatorService = new ValidatorService(undefined, this._locationService, this._clickhouseClient);
    await this._validatorService.initialize();

    // Initialize database validator with ClickHouse client only
    this._databaseValidator = new DatabaseValidatorInitializer(this._clickhouseClient);

    // Sync location data to database after processing
    logger.info('🔄 Syncing location data to database...');
    await this._databaseValidator.syncLocationDataToDatabase();
    logger.info('✅ Location data synced to database');

    // Initialize staking update service
    const rpcUrl = process.env.MONAD_RPC_URL || 'http://localhost:8080';
    const stakingConfig: StakingUpdateConfig = {
      updateIntervalMs: parseInt(process.env.STAKING_UPDATE_INTERVAL_MS || '30000'),
      rpcUrl,
      clickhouseClient: this._clickhouseClient,
      redisClient: this._redisClient
    };
    
    this._stakingUpdateService = new StakingUpdateService(stakingConfig);

    // Initialize provider performance cache service
    this._providerCacheService = new ProviderPerformanceCacheService(
      this._clickhouseClient,
      this._redisClient,
      {
        updateIntervalMinutes: 15, // Update every 15 minutes
        dataWindowHours: 168, // 7 days
        enableRedisCache: true,
        redisCacheTtlSeconds: 900, // 15 minutes
        maxCalculationTimeoutMs: 120000, // 2 minutes
        enableFallbackData: true
      }
    );

    // Initialize IPC polling service for hourly validator IP updates
    const socketPath = process.env.IPC_SOCKET_PATH;
    if (socketPath) {
      const pollIntervalMs = parseInt(process.env.IPC_POLL_INTERVAL_MS || '3600000'); // Default: 1 hour
      const ipcMapper = new IpcLocationMapper(socketPath);

      // Get the ValidatorLocationService from UnifiedLocationService
      const validatorLocationService = (this._locationService as any).validatorLocationService;

      this._ipcPollingService = new IpcPollingService(
        ipcMapper,
        validatorLocationService,
        this._clickhouseClient,
        pollIntervalMs
      );

      // Start IPC polling
      await this._ipcPollingService.start();
      logger.info('✅ IPC polling service started successfully');
    } else {
      logger.warn('⚠️ IPC_SOCKET_PATH not configured, IPC polling disabled');
    }

    this.isInitialized = true;
    logger.info('✅ ServiceContainer initialized successfully');
  }

  /**
   * Get ClickHouse client instance
   */
  getClickHouseClient(): MonadClickHouseClient {
    if (!this._clickhouseClient) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return this._clickhouseClient;
  }

  /**
   * Get Redis client instance
   */
  getRedisClient(): MonadRedisClient {
    if (!this._redisClient) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return this._redisClient;
  }

  /**
   * Get ValidatorService instance
   */
  getValidatorService(): ValidatorService {
    if (!this._validatorService) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return this._validatorService;
  }

  /**
   * Get UnifiedLocationService instance
   */
  getLocationService(): UnifiedLocationService {
    if (!this._locationService) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return this._locationService;
  }

  /**
   * Get DatabaseValidatorInitializer instance
   */
  getDatabaseValidator(): DatabaseValidatorInitializer {
    if (!this._databaseValidator) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return this._databaseValidator;
  }

  /**
   * Get ProviderPerformanceCacheService instance
   */
  getProviderCacheService(): ProviderPerformanceCacheService {
    if (!this._providerCacheService) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return this._providerCacheService;
  }

  /**
   * Get StakingUpdateService instance
   */
  getStakingUpdateService(): StakingUpdateService | null {
    return this._stakingUpdateService;
  }

  /**
   * Get ValidatorInfoUpdateService instance
   */
  getValidatorInfoUpdateService(): ValidatorInfoUpdateService {
    if (!this._validatorInfoUpdateService) {
      const network = (process.env.VALIDATOR_NETWORK || 'testnet') as ValidatorNetwork;
      const githubToken = process.env.GITHUB_TOKEN;

      const validatorInfoRegistry = new ValidatorInfoRegistry({ network, githubToken });
      this._validatorInfoUpdateService = new ValidatorInfoUpdateService(
        this.getClickHouseClient(),
        validatorInfoRegistry,
        60 * 60 * 1000 // 1 hour
      );
    }
    return this._validatorInfoUpdateService;
  }

  /**
   * Cleanup all services
   */
  async shutdown(): Promise<void> {
    logger.info('🔄 Shutting down ServiceContainer...');

    try {
      if (this._clickhouseClient) {
        await this._clickhouseClient.close();
      }
      if (this._redisClient) {
        await this._redisClient.close();
      }

      this._clickhouseClient = null;
      this._redisClient = null;
      this._validatorService = null;
      this._locationService = null;
      this._databaseValidator = null;
      this._providerCacheService = null;
      
      if (this._stakingUpdateService) {
        this._stakingUpdateService.stop();
        this._stakingUpdateService = null;
      }

      if (this._validatorInfoUpdateService) {
        this._validatorInfoUpdateService.stop();
        this._validatorInfoUpdateService = null;
      }

      if (this._ipcPollingService) {
        this._ipcPollingService.stop();
        this._ipcPollingService = null;
      }

      this.isInitialized = false;

      logger.info('✅ ServiceContainer shutdown complete');
    } catch (error) {
      logger.error('Error during ServiceContainer shutdown:', error);
      throw error;
    }
  }

  /**
   * Check if container is initialized
   */
  get initialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Reset singleton instance (for testing)
   */
  static reset(): void {
    ServiceContainer.instance = null;
  }
} 
