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

    // Initialize Redis client
    this._redisClient = new MonadRedisClient(this.config.redis);

    // Initialize location service first (no dependencies)
    this._locationService = new UnifiedLocationService();
    await this._locationService.initialize();
    
    // Process all validator locations to populate the service with real data
    logger.info('🌍 Processing validator locations...');
    await this._locationService.processAllValidatorLocations();
    logger.info('✅ Validator location processing complete');

    // Initialize validator service with location service dependency
    this._validatorService = new ValidatorService(undefined, this._locationService);
    await this._validatorService.initialize();

    // Initialize database validator with ClickHouse client only
    this._databaseValidator = new DatabaseValidatorInitializer(this._clickhouseClient);

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