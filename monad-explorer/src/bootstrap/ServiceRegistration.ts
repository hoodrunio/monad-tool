import { serviceContainer } from '../services/core/ServiceContainer';
import { appConfig, AppConfig } from '../config/AppConfig';
import { RpcClient } from '../services/blockchain/RpcClient';
import { TokenDetectionService } from '../services/token/TokenDetectionService';
import { RedisCache } from '../services/cache/RedisCache';
import { logger } from '../utils/logger';

// Import interfaces
import { IRpcClient } from '../interfaces/blockchain/IRpcClient';
import { ITokenDetectionService } from '../interfaces/services/ITokenDetectionService';
import { ICacheService } from '../interfaces/cache/ICacheService';

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

    // Register Cache Service (Redis or Memory based on config)
    serviceContainer.registerFactory<ICacheService>('cacheService', async () => {
      if (this.config.cache.type === 'redis' && this.config.cache.redis) {
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
      } else {
        // Fallback to in-memory cache
        return new InMemoryCache(this.config.cache);
      }
    });

    logger.debug('Infrastructure services registered');
  }

  private registerBusinessServices(): void {
    // Register Token Detection Service
    serviceContainer.registerFactory<ITokenDetectionService>('tokenDetectionService', async () => {
      const rpcClient = await serviceContainer.resolveInternal<IRpcClient>('rpcClient');
      const cacheService = await serviceContainer.resolveInternal<ICacheService>('cacheService');
      return new TokenDetectionService(rpcClient, cacheService);
    });

    logger.debug('Business services registered');
  }
}

/**
 * Simple in-memory cache fallback implementation
 */
class InMemoryCache implements ICacheService {
  private readonly cache = new Map<string, { value: unknown; expires?: number }>();
  private readonly config: { defaultTtl: number; maxSize: number; enableMetrics: boolean };
  private readonly metrics = {
    totalRequests: 0,
    hits: 0,
    misses: 0,
    hitRate: 0,
    size: 0,
    maxSize: 0,
    evictions: 0,
    memoryUsage: 0,
  };

  constructor(config: { defaultTtl: number; maxSize: number; enableMetrics: boolean }) {
    this.config = config;
    this.metrics.maxSize = config.maxSize;
  }

  async get<T>(key: string): Promise<T | null> {
    this.metrics.totalRequests++;
    
    const entry = this.cache.get(key);
    if (!entry) {
      this.metrics.misses++;
      this.updateHitRate();
      return null;
    }

    if (entry.expires && Date.now() > entry.expires) {
      this.cache.delete(key);
      this.metrics.misses++;
      this.updateHitRate();
      return null;
    }

    this.metrics.hits++;
    this.updateHitRate();
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const expires = ttl ? Date.now() + ttl : undefined;
    
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.config.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.metrics.evictions++;
      }
    }

    this.cache.set(key, { value, expires });
    this.metrics.size = this.cache.size;
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (entry.expires && Date.now() > entry.expires) {
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
    this.metrics.size = 0;
  }

  async getMultiple<T>(keys: string[]): Promise<(T | null)[]> {
    const results: (T | null)[] = [];
    for (const key of keys) {
      results.push(await this.get<T>(key));
    }
    return results;
  }

  async setMultiple<T>(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.ttl);
    }
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttl?: number): Promise<T> {
    const existing = await this.get<T>(key);
    if (existing !== null) return existing;
    
    const value = await factory();
    await this.set(key, value, ttl);
    return value;
  }

  async increment(key: string, delta = 1): Promise<number> {
    const current = await this.get<number>(key) || 0;
    const newValue = current + delta;
    await this.set(key, newValue);
    return newValue;
  }

  async decrement(key: string, delta = 1): Promise<number> {
    return this.increment(key, -delta);
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    entry.expires = Date.now() + ttl;
    return true;
  }

  async getTtl(key: string): Promise<number> {
    const entry = this.cache.get(key);
    if (!entry || !entry.expires) return -1;
    
    const remaining = entry.expires - Date.now();
    return remaining > 0 ? remaining : -1;
  }

  async keys(pattern = '*'): Promise<string[]> {
    const allKeys = Array.from(this.cache.keys());
    if (pattern === '*') return allKeys;
    
    // Simple pattern matching
    const regex = new RegExp(pattern.replace('*', '.*'));
    return allKeys.filter(key => regex.test(key));
  }

  async size(): Promise<number> {
    return this.cache.size;
  }

  async getMetrics() {
    return { ...this.metrics };
  }

  async resetMetrics(): Promise<void> {
    this.metrics.totalRequests = 0;
    this.metrics.hits = 0;
    this.metrics.misses = 0;
    this.metrics.hitRate = 0;
    this.metrics.evictions = 0;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expires && now > entry.expires) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    this.metrics.size = this.cache.size;
    return cleaned;
  }

  async getHealthStatus() {
    return {
      healthy: true,
      responseTime: 1,
      errorCount: 0,
    };
  }

  private updateHitRate(): void {
    if (this.metrics.totalRequests > 0) {
      this.metrics.hitRate = this.metrics.hits / this.metrics.totalRequests;
    }
  }
} 