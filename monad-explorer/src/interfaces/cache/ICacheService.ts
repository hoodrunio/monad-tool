export interface CacheEntry<T = unknown> {
  value: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheOptions {
  ttl?: number; // Time to live in milliseconds
  maxSize?: number;
  enableMetrics?: boolean;
}

export interface CacheMetrics {
  totalRequests: number;
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
  evictions: number;
  memoryUsage?: number;
}

export interface ICacheService {
  /**
   * Get value from cache
   */
  get<T = unknown>(key: string): Promise<T | null>;

  /**
   * Set value in cache
   */
  set<T = unknown>(key: string, value: T, ttl?: number): Promise<void>;

  /**
   * Check if key exists in cache
   */
  has(key: string): Promise<boolean>;

  /**
   * Delete key from cache
   */
  delete(key: string): Promise<boolean>;

  /**
   * Clear all cache entries
   */
  clear(): Promise<void>;

  /**
   * Get multiple values at once
   */
  getMultiple<T = unknown>(keys: string[]): Promise<(T | null)[]>;

  /**
   * Set multiple values at once
   */
  setMultiple<T = unknown>(
    entries: Array<{ key: string; value: T; ttl?: number }>
  ): Promise<void>;

  /**
   * Get or set value (cache-aside pattern)
   */
  getOrSet<T = unknown>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T>;

  /**
   * Increment numeric value
   */
  increment(key: string, delta?: number): Promise<number>;

  /**
   * Decrement numeric value
   */
  decrement(key: string, delta?: number): Promise<number>;

  /**
   * Extend TTL for existing key
   */
  expire(key: string, ttl: number): Promise<boolean>;

  /**
   * Get time to live for key
   */
  getTtl(key: string): Promise<number>;

  /**
   * Get all keys matching pattern
   */
  keys(pattern?: string): Promise<string[]>;

  /**
   * Get cache size
   */
  size(): Promise<number>;

  /**
   * Get cache metrics
   */
  getMetrics(): Promise<CacheMetrics>;

  /**
   * Reset metrics
   */
  resetMetrics(): Promise<void>;

  /**
   * Cleanup expired entries
   */
  cleanup(): Promise<number>;

  /**
   * Get health status
   */
  getHealthStatus(): Promise<{
    healthy: boolean;
    responseTime: number;
    errorCount: number;
    lastError?: string;
  }>;
} 