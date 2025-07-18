import { serviceContainer } from '../services/core/ServiceContainer';
import { appConfig, AppConfig } from '../config/AppConfig';
import { RpcClient } from '../services/blockchain/RpcClient';
import { TokenDetectionService } from '../services/token/TokenDetectionService';
import { EventTokenDetector } from '../services/token/EventTokenDetector';
import { RedisTokenRepository } from '../services/token/RedisTokenRepository';
import { MulticallTokenMetadataFetcher } from '../services/token/MulticallTokenMetadataFetcher';
import { ContractMetadataFetcher } from '../services/contract/ContractMetadataFetcher';
import { ContractDiscoveryService } from '../services/contract/ContractDiscoveryService';
import { OptimizedContractFilter } from '../services/contract/OptimizedContractFilter';
import { RedisCache } from '../services/cache/RedisCache';
import { RabbitMQService } from '../services/queue/RabbitMQService';
import { LogTokenTransferParser } from '../services/parsing/LogTokenTransferParser';
import { TransactionService } from '../services/transaction/TransactionService';
import { InternalTransactionService } from '../services/transaction/InternalTransactionService';
import { logger } from '../utils/logger';

// Import interfaces
import { IRpcClient } from '../interfaces/blockchain/IRpcClient';
import { ITokenDetectionService } from '../interfaces/services/ITokenDetectionService';
import { IEventTokenDetector } from '../interfaces/services/IEventTokenDetector';
import { ITokenRepository } from '../interfaces/services/ITokenRepository';
import { ITokenMetadataFetcher } from '../interfaces/services/ITokenMetadataFetcher';
import { IContractMetadataFetcher } from '../interfaces/services/IContractMetadataFetcher';
import { IContractDiscoveryService } from '../interfaces/services/IContractDiscoveryService';
import { IOptimizedContractFilter } from '../interfaces/services/IOptimizedContractFilter';
import { ICacheService } from '../interfaces/cache/ICacheService';
import { IQueueService } from '../interfaces/services/IQueueService';
import { ILogTokenTransferParser } from '../interfaces/processing/ILogTokenTransferParser';
import { ITransactionService } from '../interfaces/services/ITransactionService';
import { IInternalTransactionService } from '../interfaces/services/IInternalTransactionService';

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

    // Register Redis Cache Service (Redis only) - with fallback for connection failures
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
      
      try {
        const cache = new RedisCache(redisConfig);
        await cache.connect();
        logger.info('Redis cache service connected successfully');
        return cache;
      } catch (error) {
        logger.warn('Failed to connect to Redis cache - using fallback in-memory cache', {
          error: error instanceof Error ? error.message : 'Unknown error',
          host: this.config.cache.redis.host,
          port: this.config.cache.redis.port,
        });
        
        // Return a simple in-memory cache fallback
        return new (class implements ICacheService {
          private cache = new Map<string, { value: any; expiry: number }>();
          
          async get<T = unknown>(key: string): Promise<T | null> {
            const entry = this.cache.get(key);
            if (!entry || entry.expiry < Date.now()) {
              this.cache.delete(key);
              return null;
            }
            return entry.value as T;
          }
          
          async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
            const expiry = ttl ? Date.now() + ttl : Date.now() + 300000; // 5 min default
            this.cache.set(key, { value, expiry });
          }
          
          async has(key: string): Promise<boolean> {
            const entry = this.cache.get(key);
            if (!entry || entry.expiry < Date.now()) {
              this.cache.delete(key);
              return false;
            }
            return true;
          }
          
          async delete(key: string): Promise<boolean> {
            return this.cache.delete(key);
          }
          
          async clear(): Promise<void> {
            this.cache.clear();
          }
          
          async getMultiple<T = unknown>(keys: string[]): Promise<(T | null)[]> {
            return Promise.all(keys.map(key => this.get<T>(key)));
          }
          
          async setMultiple<T = unknown>(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
            for (const entry of entries) {
              await this.set(entry.key, entry.value, entry.ttl);
            }
          }
          
          async getOrSet<T = unknown>(key: string, factory: () => Promise<T>, ttl?: number): Promise<T> {
            const existing = await this.get<T>(key);
            if (existing !== null) return existing;
            const value = await factory();
            await this.set(key, value, ttl);
            return value;
          }
          
          async increment(key: string, delta: number = 1): Promise<number> {
            const current = await this.get<number>(key) || 0;
            const newValue = current + delta;
            await this.set(key, newValue);
            return newValue;
          }
          
          async decrement(key: string, delta: number = 1): Promise<number> {
            return this.increment(key, -delta);
          }
          
          async expire(key: string, ttl: number): Promise<boolean> {
            const entry = this.cache.get(key);
            if (!entry) return false;
            entry.expiry = Date.now() + ttl;
            return true;
          }
          
          async getTtl(key: string): Promise<number> {
            const entry = this.cache.get(key);
            if (!entry) return -1;
            return Math.max(0, entry.expiry - Date.now());
          }
          
          async keys(pattern?: string): Promise<string[]> {
            return Array.from(this.cache.keys());
          }
          
          async size(): Promise<number> {
            return this.cache.size;
          }
          
          async getMetrics(): Promise<any> {
            return { totalRequests: 0, hits: 0, misses: 0, hitRate: 0, size: this.cache.size };
          }
          
          async resetMetrics(): Promise<void> {
            // No-op
          }
          
          async cleanup(): Promise<number> {
            let cleaned = 0;
            const now = Date.now();
            for (const [key, entry] of this.cache.entries()) {
              if (entry.expiry < now) {
                this.cache.delete(key);
                cleaned++;
              }
            }
            return cleaned;
          }
          
          async getHealthStatus(): Promise<any> {
            return { healthy: true, responseTime: 0, errorCount: 0 };
          }
        })();
      }
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

    // Register Contract Metadata Fetcher (for comprehensive contract analysis)
    serviceContainer.registerFactory<IContractMetadataFetcher>('contractMetadataFetcher', async () => {
      const rpcClient = await serviceContainer.resolveInternal<IRpcClient>('rpcClient');
      const tokenDetectionService = await serviceContainer.resolveInternal<ITokenDetectionService>('tokenDetectionService');
      const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService');
      return new ContractMetadataFetcher(rpcClient, tokenDetectionService, cacheService);
    });

    // Register Optimized Contract Filter (for RPC call reduction)
    serviceContainer.registerFactory<IOptimizedContractFilter>('optimizedContractFilter', async () => {
      const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService');
      // DataSource will be passed when needed
      return new OptimizedContractFilter(cacheService);
    });

    // Register Contract Discovery Service (for on-demand contract detection)
    serviceContainer.registerFactory<IContractDiscoveryService>('contractDiscoveryService', async () => {
      const rpcClient = await serviceContainer.resolveInternal<IRpcClient>('rpcClient');
      const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService');
      const optimizedFilter = await serviceContainer.resolveInternal<IOptimizedContractFilter>('optimizedContractFilter');
      // DataSource will be passed when needed
      return new ContractDiscoveryService(rpcClient, cacheService, optimizedFilter);
    });

    // Register Token Detection Service (with all dependencies)
    serviceContainer.registerFactory<ITokenDetectionService>('tokenDetectionService', async () => {
      const eventDetector = await serviceContainer.resolveInternal<IEventTokenDetector>('eventTokenDetector');
      const tokenRepository = await serviceContainer.resolveInternal<ITokenRepository>('tokenRepository');
      const metadataFetcher = await serviceContainer.resolveInternal<ITokenMetadataFetcher>('tokenMetadataFetcher');
      const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService');
      
      return new TokenDetectionService(eventDetector, tokenRepository, metadataFetcher, cacheService);
    });

    // Register Log Token Transfer Parser (for runtime parsing from logs)
    serviceContainer.registerFactory<ILogTokenTransferParser>('logTokenTransferParser', async () => {
      const eventDetector = await serviceContainer.resolveInternal<IEventTokenDetector>('eventTokenDetector');
      const tokenRepository = await serviceContainer.resolveInternal<ITokenRepository>('tokenRepository');
      
      return new LogTokenTransferParser(eventDetector, tokenRepository);
    });

    // Register Transaction Service (with runtime token transfer parsing)
    // Note: TransactionService requires store parameter which will be passed during resolution
    serviceContainer.registerInstance<any>('transactionServiceFactory', {
      async create(store: any): Promise<ITransactionService> {
        const logTokenTransferParser = await serviceContainer.resolveInternal<ILogTokenTransferParser>('logTokenTransferParser');
        const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService').catch(() => undefined);
        const rpcClient = await serviceContainer.resolveInternal<IRpcClient>('rpcClient');
        
        // Create internal transaction service for transaction service integration
        const internalTransactionService = new InternalTransactionService(rpcClient, cacheService, store);
        
        return new TransactionService(store, logTokenTransferParser, cacheService, internalTransactionService, rpcClient);
      }
    });

    // Register Internal Transaction Service (on-demand tracing)  
    // Note: InternalTransactionService requires store parameter for address-based queries
    serviceContainer.registerInstance<any>('internalTransactionServiceFactory', {
      async create(store?: any): Promise<IInternalTransactionService> {
        const rpcClient = await serviceContainer.resolveInternal<IRpcClient>('rpcClient');
        const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService').catch(() => undefined);
        
        return new InternalTransactionService(rpcClient, cacheService, store);
      }
    });

    logger.debug('Business services registered');
  }
}

 