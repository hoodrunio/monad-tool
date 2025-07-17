import { ICacheService, CacheMetrics, CacheOptions } from '../../interfaces/cache/ICacheService';
import { logger } from '../../utils/logger';

/**
 * Advanced Cache Service with Multi-Level Caching Strategy
 * 
 * Implements:
 * - L1: In-Memory Cache (hot data, sub-ms access)
 * - L2: Redis Cache (warm data, ~1ms access)
 * - Smart cache warming for predictable access patterns
 * - Intelligent TTL management based on data characteristics
 * - Cache invalidation patterns for blockchain data
 */
export class AdvancedCacheService implements ICacheService {
  private readonly memoryCache = new Map<string, { value: any; expiry: number; hits: number }>();
  private readonly maxMemorySize: number;
  private readonly redisCache: ICacheService;
  private readonly metrics: CacheMetrics;
  
  // Cache warming patterns for blockchain explorer
  private readonly warmingPatterns = {
    // Latest blocks are frequently accessed
    latestBlocks: { pattern: 'blocks:list:*:0', interval: 10000, ttl: 30000 },
    // Latest transactions are frequently accessed  
    latestTransactions: { pattern: 'transactions:list:*:0', interval: 15000, ttl: 15000 },
    // Popular addresses get cached longer
    popularAddresses: { pattern: 'addresses:*', minHits: 5, ttl: 300000 },
    // Block details are stable after confirmation
    confirmedBlocks: { pattern: 'blocks:*', confirmationDelay: 60000, ttl: 1800000 }
  };

  constructor(
    redisCache: ICacheService,
    options: CacheOptions = {}
  ) {
    this.redisCache = redisCache;
    this.maxMemorySize = options.maxSize || 10000;
    
    this.metrics = {
      totalRequests: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
      size: 0,
      maxSize: this.maxMemorySize,
      evictions: 0,
      memoryUsage: 0,
    };

    // Start cache warming and cleanup processes
    this.startCacheWarming();
    this.startCleanupProcess();
    
    logger.info('Advanced Cache Service initialized', {
      maxMemorySize: this.maxMemorySize,
      warmingPatternsCount: Object.keys(this.warmingPatterns).length
    });
  }

  /**
   * Multi-level get with L1 memory cache and L2 Redis cache
   */
  public async get<T = unknown>(key: string): Promise<T | null> {
    this.metrics.totalRequests++;

    // L1: Check memory cache first (fastest)
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && memoryEntry.expiry > Date.now()) {
      memoryEntry.hits++;
      this.metrics.hits++;
      this.updateHitRate();
      
      logger.debug('Cache hit (L1 memory)', { key, hits: memoryEntry.hits });
      return memoryEntry.value as T;
    }

    // L2: Check Redis cache
    try {
      const redisValue = await this.redisCache.get<T>(key);
      if (redisValue !== null) {
        // Promote to L1 cache if frequently accessed or likely to be accessed again
        this.promoteToMemoryCache(key, redisValue);
        
        this.metrics.hits++;
        this.updateHitRate();
        
        logger.debug('Cache hit (L2 Redis)', { key });
        return redisValue;
      }
    } catch (error) {
      logger.warn('Redis cache error, continuing without cache', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    // Cache miss
    this.metrics.misses++;
    this.updateHitRate();
    
    return null;
  }

  /**
   * Multi-level set with intelligent TTL and promotion strategies
   */
  public async set<T = unknown>(key: string, value: T, ttl?: number): Promise<void> {
    const cacheTtl = ttl || this.getIntelligentTTL(key);

    try {
      // Always set in Redis (L2)
      await this.redisCache.set(key, value, cacheTtl);

      // Promote to memory cache (L1) based on access patterns
      if (this.shouldPromoteToMemory(key, value)) {
        this.setInMemoryCache(key, value, cacheTtl);
      }

      logger.debug('Cache set (multi-level)', { 
        key, 
        ttl: cacheTtl,
        promotedToMemory: this.memoryCache.has(key)
      });
    } catch (error) {
      logger.error('Cache set failed', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Check cache existence across both levels
   */
  public async has(key: string): Promise<boolean> {
    // Check L1 first
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && memoryEntry.expiry > Date.now()) {
      return true;
    }

    // Check L2
    try {
      return await this.redisCache.has(key);
    } catch (error) {
      return false;
    }
  }

  /**
   * Delete from both cache levels
   */
  public async delete(key: string): Promise<boolean> {
    let deleted = false;

    // Delete from L1
    if (this.memoryCache.delete(key)) {
      deleted = true;
    }

    // Delete from L2
    try {
      const redisDeleted = await this.redisCache.delete(key);
      deleted = deleted || redisDeleted;
    } catch (error) {
      logger.warn('Redis delete failed', { key, error });
    }

    return deleted;
  }

  /**
   * Clear both cache levels
   */
  public async clear(): Promise<void> {
    this.memoryCache.clear();
    try {
      await this.redisCache.clear();
    } catch (error) {
      logger.warn('Redis clear failed', { error });
    }
  }

  /**
   * Optimized batch get with single Redis call
   */
  public async getMultiple<T = unknown>(keys: string[]): Promise<(T | null)[]> {
    const results: (T | null)[] = new Array(keys.length).fill(null);
    const missedKeys: number[] = [];

    // Check L1 cache for all keys
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const memoryEntry = this.memoryCache.get(key);
      
      if (memoryEntry && memoryEntry.expiry > Date.now()) {
        results[i] = memoryEntry.value as T;
        memoryEntry.hits++;
        this.metrics.hits++;
      } else {
        missedKeys.push(i);
      }
      
      this.metrics.totalRequests++;
    }

    // Batch get from Redis for missed keys
    if (missedKeys.length > 0) {
      try {
        const redisKeys = missedKeys.map(i => keys[i]);
        const redisResults = await this.redisCache.getMultiple<T>(redisKeys);
        
        for (let j = 0; j < missedKeys.length; j++) {
          const originalIndex = missedKeys[j];
          const redisValue = redisResults[j];
          
          if (redisValue !== null) {
            results[originalIndex] = redisValue;
            this.promoteToMemoryCache(keys[originalIndex], redisValue);
            this.metrics.hits++;
          } else {
            this.metrics.misses++;
          }
        }
      } catch (error) {
        logger.warn('Redis batch get failed', { error });
        this.metrics.misses += missedKeys.length;
      }
    }

    this.updateHitRate();
    return results;
  }

  /**
   * Batch set with intelligent promotion
   */
  public async setMultiple<T = unknown>(
    entries: Array<{ key: string; value: T; ttl?: number }>
  ): Promise<void> {
    try {
      await this.redisCache.setMultiple(entries);
      
      // Promote frequently accessed patterns to memory
      for (const entry of entries) {
        if (this.shouldPromoteToMemory(entry.key, entry.value)) {
          const ttl = entry.ttl || this.getIntelligentTTL(entry.key);
          this.setInMemoryCache(entry.key, entry.value, ttl);
        }
      }
    } catch (error) {
      logger.error('Batch cache set failed', { error });
      throw error;
    }
  }

  /**
   * Cache-aside pattern with intelligent caching
   */
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
    
    // Store with intelligent TTL
    const cacheTtl = ttl || this.getIntelligentTTL(key);
    await this.set(key, value, cacheTtl);
    
    return value;
  }

  // Delegate remaining methods to Redis cache
  public async increment(key: string, delta?: number): Promise<number> {
    return await this.redisCache.increment(key, delta);
  }

  public async decrement(key: string, delta?: number): Promise<number> {
    return await this.redisCache.decrement(key, delta);
  }

  public async expire(key: string, ttl: number): Promise<boolean> {
    // Update memory cache expiry
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry) {
      memoryEntry.expiry = Date.now() + ttl;
    }
    
    return await this.redisCache.expire(key, ttl);
  }

  public async getTtl(key: string): Promise<number> {
    return await this.redisCache.getTtl(key);
  }

  public async keys(pattern?: string): Promise<string[]> {
    return await this.redisCache.keys(pattern);
  }

  public async size(): Promise<number> {
    const redisSize = await this.redisCache.size();
    return redisSize + this.memoryCache.size;
  }

  public async getMetrics(): Promise<CacheMetrics> {
    const redisMetrics = await this.redisCache.getMetrics();
    
    return {
      ...this.metrics,
      size: this.memoryCache.size + redisMetrics.size,
      memoryUsage: this.estimateMemoryUsage() + (redisMetrics.memoryUsage || 0),
    };
  }

  public async resetMetrics(): Promise<void> {
    this.metrics.totalRequests = 0;
    this.metrics.hits = 0;
    this.metrics.misses = 0;
    this.metrics.hitRate = 0;
    this.metrics.evictions = 0;
    
    await this.redisCache.resetMetrics();
  }

  public async cleanup(): Promise<number> {
    const cleaned = this.cleanupMemoryCache();
    const redisCleaned = await this.redisCache.cleanup();
    
    return cleaned + redisCleaned;
  }

  public async getHealthStatus(): Promise<{
    healthy: boolean;
    responseTime: number;
    errorCount: number;
    lastError?: string;
  }> {
    const startTime = Date.now();
    
    try {
      // Test both cache levels
      const testKey = 'health_check_' + Date.now();
      await this.set(testKey, 'test', 1000);
      await this.get(testKey);
      await this.delete(testKey);
      
      const responseTime = Date.now() - startTime;
      
      return {
        healthy: true,
        responseTime,
        errorCount: 0,
      };
    } catch (error) {
      return {
        healthy: false,
        responseTime: Date.now() - startTime,
        errorCount: 1,
        lastError: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Private helper methods
   */

  private shouldPromoteToMemory<T>(key: string, value: T): boolean {
    // Promote latest data patterns
    if (key.includes('latest') || key.includes('list:') && key.endsWith(':0')) {
      return true;
    }
    
    // Promote frequently accessed items
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && memoryEntry.hits >= 3) {
      return true;
    }
    
    // Promote small values
    const valueSize = this.estimateSize(value);
    return valueSize < 1024; // Less than 1KB
  }

  private promoteToMemoryCache<T>(key: string, value: T): void {
    const ttl = this.getIntelligentTTL(key);
    this.setInMemoryCache(key, value, ttl);
  }

  private setInMemoryCache<T>(key: string, value: T, ttl: number): void {
    // Evict if at capacity
    if (this.memoryCache.size >= this.maxMemorySize) {
      this.evictLeastUsed();
    }

    this.memoryCache.set(key, {
      value,
      expiry: Date.now() + ttl,
      hits: 0
    });
  }

  private evictLeastUsed(): void {
    let leastUsedKey: string | null = null;
    let leastHits = Infinity;

    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.hits < leastHits) {
        leastHits = entry.hits;
        leastUsedKey = key;
      }
    }

    if (leastUsedKey) {
      this.memoryCache.delete(leastUsedKey);
      this.metrics.evictions++;
    }
  }

  private getIntelligentTTL(key: string): number {
    // Latest data - short TTL
    if (key.includes('latest')) return 10000;
    
    // List data - medium TTL
    if (key.includes('list:')) return 30000;
    
    // Specific items - longer TTL
    if (key.match(/^(blocks|transactions|addresses):\w+$/)) return 300000;
    
    // Internal/expensive operations - very long TTL
    if (key.includes('internal') || key.includes('token-transfers')) return 600000;
    
    // Default
    return 60000;
  }

  private cleanupMemoryCache(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expiry <= now) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  private estimateMemoryUsage(): number {
    let totalSize = 0;
    
    for (const [key, entry] of this.memoryCache.entries()) {
      totalSize += key.length * 2; // String overhead
      totalSize += this.estimateSize(entry.value);
      totalSize += 24; // Entry overhead
    }
    
    return totalSize;
  }

  private estimateSize(value: any): number {
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;
    if (value === null || value === undefined) return 0;
    
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 100; // Fallback estimate
    }
  }

  private updateHitRate(): void {
    this.metrics.hitRate = this.metrics.totalRequests > 0 
      ? (this.metrics.hits / this.metrics.totalRequests) * 100 
      : 0;
  }

  private startCacheWarming(): void {
    // Warm latest blocks every 10 seconds
    setInterval(async () => {
      try {
        const key = 'blocks:list:10:0';
        const exists = await this.has(key);
        if (!exists) {
          logger.debug('Cache warming triggered for latest blocks');
          // Note: In real implementation, you'd call the actual service here
        }
      } catch (error) {
        logger.debug('Cache warming failed', { error });
      }
    }, 10000);

    // Warm latest transactions every 15 seconds
    setInterval(async () => {
      try {
        const key = 'transactions:list:20:0';
        const exists = await this.has(key);
        if (!exists) {
          logger.debug('Cache warming triggered for latest transactions');
          // Note: In real implementation, you'd call the actual service here
        }
      } catch (error) {
        logger.debug('Cache warming failed', { error });
      }
    }, 15000);
  }

  private startCleanupProcess(): void {
    // Cleanup expired entries every minute
    setInterval(() => {
      const cleaned = this.cleanupMemoryCache();
      if (cleaned > 0) {
        logger.debug('Memory cache cleanup completed', { itemsCleaned: cleaned });
      }
    }, 60000);
  }
} 