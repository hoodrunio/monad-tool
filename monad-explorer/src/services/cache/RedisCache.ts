import Redis, { RedisOptions } from 'ioredis';
import { ICacheService, CacheMetrics } from '../../interfaces/cache/ICacheService';
import { logger } from '../../utils/logger';

export interface RedisCacheConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  defaultTtl: number;
  maxRetries: number;
  retryDelayOnFailover: number;
  enableReadyCheck: boolean;
  maxRetriesPerRequest?: number;
  connectTimeout: number;
  commandTimeout: number;
}

export class RedisCache implements ICacheService {
  private readonly client: Redis;
  private readonly config: RedisCacheConfig;
  private isConnected = false;
  private readonly metrics: CacheMetrics;

  constructor(config: RedisCacheConfig) {
    this.config = config;
    this.metrics = {
      totalRequests: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 0,
      maxSize: -1, // Redis doesn't have a fixed max size
      evictions: 0,
      memoryUsage: 0,
    };

    const redisOptions: RedisOptions = {
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db || 0,
      keyPrefix: config.keyPrefix || 'monad:',
      enableReadyCheck: config.enableReadyCheck,
      maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
      connectTimeout: config.connectTimeout,
      commandTimeout: config.commandTimeout,
      lazyConnect: true,
      keepAlive: 30000,
      family: 4,
      enableOfflineQueue: false,
    };

    this.client = new Redis(redisOptions);
    this.setupEventHandlers();
  }

  public async connect(): Promise<void> {
    try {
      await this.client.connect();
      this.isConnected = true;
      logger.info('Redis cache connected successfully', {
        host: this.config.host,
        port: this.config.port,
        db: this.config.db,
      });
    } catch (error) {
      logger.error('Failed to connect to Redis cache', {
        error: error instanceof Error ? error.message : 'Unknown error',
        host: this.config.host,
        port: this.config.port,
      });
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await this.client.quit();
      this.isConnected = false;
      logger.info('Redis cache disconnected successfully');
    } catch (error) {
      logger.error('Error disconnecting from Redis cache', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  public async get<T = unknown>(key: string): Promise<T | null> {
    this.metrics.totalRequests++;

    try {
      const value = await this.client.get(key);
      
      if (value === null) {
        this.metrics.misses++;
        this.updateHitRate();
        return null;
      }

      this.metrics.hits++;
      this.updateHitRate();

      try {
        return JSON.parse(value) as T;
      } catch {
        // If parsing fails, return as string
        return value as unknown as T;
      }
    } catch (error) {
      logger.error('Redis GET operation failed', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.metrics.misses++;
      this.updateHitRate();
      return null;
    }
  }

  public async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const serializedValue = typeof value === 'string' ? value : JSON.stringify(value);
      const cacheTtl = ttl || this.config.defaultTtl;

      if (cacheTtl > 0) {
        await this.client.setex(key, Math.floor(cacheTtl / 1000), serializedValue);
      } else {
        await this.client.set(key, serializedValue);
      }

      logger.debug('Redis SET operation completed', {
        key,
        ttl: cacheTtl,
        valueType: typeof value,
      });
    } catch (error) {
      logger.error('Redis SET operation failed', {
        key,
        ttl,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  public async has(key: string): Promise<boolean> {
    try {
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (error) {
      logger.error('Redis EXISTS operation failed', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  public async delete(key: string): Promise<boolean> {
    try {
      const deleted = await this.client.del(key);
      return deleted === 1;
    } catch (error) {
      logger.error('Redis DELETE operation failed', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  public async clear(): Promise<void> {
    try {
      await this.client.flushdb();
      logger.info('Redis cache cleared successfully');
    } catch (error) {
      logger.error('Redis FLUSHDB operation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  public async getMultiple<T = unknown>(keys: string[]): Promise<(T | null)[]> {
    try {
      const values = await this.client.mget(...keys);
      
      return values.map((value, index) => {
        this.metrics.totalRequests++;
        
        if (value === null) {
          this.metrics.misses++;
          return null;
        }

        this.metrics.hits++;

        try {
          return JSON.parse(value) as T;
        } catch {
          return value as unknown as T;
        }
      });
    } catch (error) {
      logger.error('Redis MGET operation failed', {
        keyCount: keys.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      
      // Return array of nulls on error
      keys.forEach(() => {
        this.metrics.totalRequests++;
        this.metrics.misses++;
      });
      
      return new Array(keys.length).fill(null);
    } finally {
      this.updateHitRate();
    }
  }

  public async setMultiple<T = unknown>(
    entries: Array<{ key: string; value: T; ttl?: number }>
  ): Promise<void> {
    try {
      const pipeline = this.client.pipeline();

      for (const { key, value, ttl } of entries) {
        const serializedValue = typeof value === 'string' ? value : JSON.stringify(value);
        const cacheTtl = ttl || this.config.defaultTtl;

        if (cacheTtl > 0) {
          pipeline.setex(key, Math.floor(cacheTtl / 1000), serializedValue);
        } else {
          pipeline.set(key, serializedValue);
        }
      }

      await pipeline.exec();

      logger.debug('Redis MSET operation completed', {
        entryCount: entries.length,
      });
    } catch (error) {
      logger.error('Redis MSET operation failed', {
        entryCount: entries.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  public async getOrSet<T = unknown>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    // Try to get existing value
    const existing = await this.get<T>(key);
    if (existing !== null) {
      return existing;
    }

    // Generate new value
    const value = await factory();
    
    // Store the value
    await this.set(key, value, ttl);
    
    return value;
  }

  public async increment(key: string, delta = 1): Promise<number> {
    try {
      return await this.client.incrby(key, delta);
    } catch (error) {
      logger.error('Redis INCRBY operation failed', {
        key,
        delta,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  public async decrement(key: string, delta = 1): Promise<number> {
    try {
      return await this.client.decrby(key, delta);
    } catch (error) {
      logger.error('Redis DECRBY operation failed', {
        key,
        delta,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  public async expire(key: string, ttl: number): Promise<boolean> {
    try {
      const result = await this.client.expire(key, Math.floor(ttl / 1000));
      return result === 1;
    } catch (error) {
      logger.error('Redis EXPIRE operation failed', {
        key,
        ttl,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  public async getTtl(key: string): Promise<number> {
    try {
      const ttl = await this.client.ttl(key);
      return ttl * 1000; // Convert to milliseconds
    } catch (error) {
      logger.error('Redis TTL operation failed', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return -1;
    }
  }

  public async keys(pattern = '*'): Promise<string[]> {
    try {
      const keys = await this.client.keys(pattern);
      
      // Remove key prefix if it exists
      if (this.config.keyPrefix) {
        return keys.map(key => key.replace(this.config.keyPrefix!, ''));
      }
      
      return keys;
    } catch (error) {
      logger.error('Redis KEYS operation failed', {
        pattern,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  public async size(): Promise<number> {
    try {
      return await this.client.dbsize();
    } catch (error) {
      logger.error('Redis DBSIZE operation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return 0;
    }
  }

  public async getMetrics(): Promise<CacheMetrics> {
    try {
      // Update size from Redis
      this.metrics.size = await this.size();
      
      // Try to get memory usage from Redis info
      const info = await this.client.info('memory');
      const memoryMatch = info.match(/used_memory:(\d+)/);
      if (memoryMatch) {
        this.metrics.memoryUsage = parseInt(memoryMatch[1], 10);
      }
    } catch (error) {
      logger.debug('Failed to update Redis metrics', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    return { ...this.metrics };
  }

  public async resetMetrics(): Promise<void> {
    this.metrics.totalRequests = 0;
    this.metrics.hits = 0;
    this.metrics.misses = 0;
    this.metrics.hitRate = 0;
    this.metrics.evictions = 0;
  }

  public async cleanup(): Promise<number> {
    // Redis handles TTL cleanup automatically
    return 0;
  }

  public async getHealthStatus(): Promise<{
    healthy: boolean;
    responseTime: number;
    errorCount: number;
    lastError?: string;
  }> {
    const startTime = Date.now();
    
    try {
      await this.client.ping();
      const responseTime = Date.now() - startTime;
      
      return {
        healthy: this.isConnected,
        responseTime,
        errorCount: 0,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      return {
        healthy: false,
        responseTime,
        errorCount: 1,
        lastError: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.info('Redis connection established');
      this.isConnected = true;
    });

    this.client.on('ready', () => {
      logger.info('Redis client ready');
    });

    this.client.on('error', (error) => {
      logger.error('Redis client error', {
        error: error.message,
      });
      this.isConnected = false;
    });

    this.client.on('close', () => {
      logger.warn('Redis connection closed');
      this.isConnected = false;
    });

    this.client.on('reconnecting', (time: number) => {
      logger.info('Redis reconnecting', { delayMs: time });
    });

    this.client.on('end', () => {
      logger.info('Redis connection ended');
      this.isConnected = false;
    });
  }

  private updateHitRate(): void {
    if (this.metrics.totalRequests > 0) {
      this.metrics.hitRate = this.metrics.hits / this.metrics.totalRequests;
    }
  }

  public async dispose(): Promise<void> {
    await this.disconnect();
  }
} 