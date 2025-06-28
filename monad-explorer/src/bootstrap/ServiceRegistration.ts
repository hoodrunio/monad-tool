import { serviceContainer } from '../services/core/ServiceContainer';
import { appConfig, AppConfig } from '../config/AppConfig';
import { RpcClient } from '../services/blockchain/RpcClient';
import { TokenDetectionService } from '../services/token/TokenDetectionService';
import { EventTokenDetector } from '../services/token/EventTokenDetector';
import { RedisTokenRepository } from '../services/token/RedisTokenRepository';
import { MulticallTokenMetadataFetcher } from '../services/token/MulticallTokenMetadataFetcher';
import { RedisCache } from '../services/cache/RedisCache';
import { RabbitMQService } from '../services/queue/RabbitMQService';
import { logger } from '../utils/logger';

// Import interfaces
import { IRpcClient } from '../interfaces/blockchain/IRpcClient';
import { ITokenDetectionService } from '../interfaces/services/ITokenDetectionService';
import { IEventTokenDetector } from '../interfaces/services/IEventTokenDetector';
import { ITokenRepository } from '../interfaces/services/ITokenRepository';
import { ITokenMetadataFetcher } from '../interfaces/services/ITokenMetadataFetcher';
import { ICacheService } from '../interfaces/cache/ICacheService';
import { IQueueService } from '../interfaces/services/IQueueService';

/**
 * Service Registration Module
 * Single Responsibility: Only handles dependency injection service registration
 */
export class ServiceRegistration {
  private readonly config: AppConfig;

  constructor() {
    this.config = appConfig.getConfig();
  }

  /**
   * Register all application services with the DI container
   */
  public registerServices(): void {
    logger.info('Registering application services...');

    try {
      // Register configuration
      this.registerConfiguration();
      
      // Register infrastructure services
      this.registerInfrastructureServices();
      
      // Register business services
      this.registerBusinessServices();

      logger.info('All services registered successfully', {
        registeredServices: serviceContainer.listServices(),
        totalCount: serviceContainer.listServices().length
      });

    } catch (error) {
      logger.error('Failed to register services', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  private registerConfiguration(): void {
    serviceContainer.registerInstance('appConfig', this.config);
    logger.debug('Configuration service registered');
  }

  private registerInfrastructureServices(): void {
    // Register RPC Client
    serviceContainer.registerFactory<IRpcClient>('rpcClient', () => {
      return new RpcClient(this.config.rpc);
    });

    // Register Redis Cache Service (Redis only)
    serviceContainer.registerFactory<ICacheService>('cacheService', async () => {
      if (!this.config.cache.redis) {
        throw new Error('Redis configuration is required');
      }

      const redisConfig = {
        ...this.config.cache.redis,
        defaultTtl: this.config.cache.defaultTtl,
        maxRetries: this.config.cache.redis.maxRetries,
        retryDelayOnFailover: this.config.cache.redis.retryDelayOnFailover,
        enableReadyCheck: this.config.cache.redis.enableReadyCheck,
        connectTimeout: this.config.cache.redis.connectTimeout,
        commandTimeout: this.config.cache.redis.commandTimeout,
      };
      
      const cache = new RedisCache(redisConfig);
      await cache.connect();
      return cache;
    });

    // Register RabbitMQ Queue Service
    serviceContainer.registerFactory<IQueueService>('queueService', async () => {
      const queueService = new RabbitMQService(this.config.queue.rabbitMqUrl);
      
      // Only connect if async processing is enabled
      if (this.config.processor.enableAsyncProcessing) {
        try {
          await queueService.connect();
          logger.info('RabbitMQ service connected successfully');
        } catch (error) {
          logger.warn('Failed to connect to RabbitMQ - async processing will be disabled', {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      } else {
        logger.debug('Async processing disabled - RabbitMQ connection skipped');
      }
      
      return queueService;
    });

    logger.debug('Infrastructure services registered');
  }

  private registerBusinessServices(): void {
    // Register Event Token Detector (no dependencies)
    serviceContainer.registerFactory<IEventTokenDetector>('eventTokenDetector', () => {
      return new EventTokenDetector();
    });

    // Register Token Repository (Redis-based)
    serviceContainer.registerFactory<ITokenRepository>('tokenRepository', async () => {
      const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService');
      return new RedisTokenRepository(cacheService);
    });

    // Register Token Metadata Fetcher (with Multicall optimization)
    serviceContainer.registerFactory<ITokenMetadataFetcher>('tokenMetadataFetcher', async () => {
      const rpcClient = await serviceContainer.resolveInternal<IRpcClient>('rpcClient');
      return new MulticallTokenMetadataFetcher(rpcClient);
    });

    // Register Token Detection Service (with all dependencies)
    serviceContainer.registerFactory<ITokenDetectionService>('tokenDetectionService', async () => {
      const eventDetector = await serviceContainer.resolveInternal<IEventTokenDetector>('eventTokenDetector');
      const tokenRepository = await serviceContainer.resolveInternal<ITokenRepository>('tokenRepository');
      const metadataFetcher = await serviceContainer.resolveInternal<ITokenMetadataFetcher>('tokenMetadataFetcher');
      const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService');
      
      return new TokenDetectionService(eventDetector, tokenRepository, metadataFetcher, cacheService);
    });

    logger.debug('Business services registered');
  }
}

 