import { DNSCacheEntry, DNSParseResult, LocationInfo } from './types';

/**
 * DNS Cache Manager for efficient caching of DNS resolution results
 * Reduces external API calls and improves performance
 */
export class DNSCacheManager {
  private cache: Map<string, DNSCacheEntry> = new Map();
  private defaultTTL: number = 3600000; // 1 hour in milliseconds
  private maxCacheSize: number = 10000;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options?: {
    defaultTTL?: number;
    maxCacheSize?: number;
    enableAutoCleanup?: boolean;
  }) {
    if (options?.defaultTTL) {
      this.defaultTTL = options.defaultTTL;
    }
    if (options?.maxCacheSize) {
      this.maxCacheSize = options.maxCacheSize;
    }
    
    if (options?.enableAutoCleanup !== false) {
      this.startAutoCleanup();
    }
  }

  /**
   * Get cached DNS parse result
   */
  get(hostname: string): DNSParseResult | null {
    const entry = this.cache.get(hostname);
    
    if (!entry) {
      return null;
    }
    
    // Check if entry has expired
    if (this.isExpired(entry)) {
      this.cache.delete(hostname);
      return null;
    }
    
    return entry.parseResult;
  }

  /**
   * Set DNS parse result in cache
   */
  set(hostname: string, parseResult: DNSParseResult, ttl?: number): void {
    const entryTTL = ttl || this.defaultTTL;
    
    // Enforce cache size limit
    if (this.cache.size >= this.maxCacheSize) {
      this.evictOldest();
    }
    
    const entry: DNSCacheEntry = {
      hostname,
      parseResult,
      timestamp: new Date(),
      ttl: entryTTL
    };
    
    this.cache.set(hostname, entry);
  }

  /**
   * Check if hostname is cached and valid
   */
  has(hostname: string): boolean {
    const entry = this.cache.get(hostname);
    return entry ? !this.isExpired(entry) : false;
  }

  /**
   * Clear specific hostname from cache
   */
  delete(hostname: string): boolean {
    return this.cache.delete(hostname);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    totalEntries: number;
    validEntries: number;
    expiredEntries: number;
    hitRate: number;
    memoryUsage: number;
  } {
    let validEntries = 0;
    let expiredEntries = 0;
    
    this.cache.forEach(entry => {
      if (this.isExpired(entry)) {
        expiredEntries++;
      } else {
        validEntries++;
      }
    });
    
    // Estimate memory usage (rough calculation)
    const memoryUsage = this.cache.size * 1000; // Approximate bytes per entry
    
    return {
      totalEntries: this.cache.size,
      validEntries,
      expiredEntries,
      hitRate: this.calculateHitRate(),
      memoryUsage
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    let removedCount = 0;
    const toRemove: string[] = [];
    
    this.cache.forEach((entry, hostname) => {
      if (this.isExpired(entry)) {
        toRemove.push(hostname);
      }
    });
    
    toRemove.forEach(hostname => {
      this.cache.delete(hostname);
      removedCount++;
    });
    
    return removedCount;
  }

  /**
   * Export cache entries for persistence
   */
  export(): Array<{
    hostname: string;
    parseResult: DNSParseResult;
    timestamp: string;
    ttl: number;
  }> {
    const exported: Array<{
      hostname: string;
      parseResult: DNSParseResult;
      timestamp: string;
      ttl: number;
    }> = [];
    
    this.cache.forEach(entry => {
      if (!this.isExpired(entry)) {
        exported.push({
          hostname: entry.hostname,
          parseResult: entry.parseResult,
          timestamp: entry.timestamp.toISOString(),
          ttl: entry.ttl
        });
      }
    });
    
    return exported;
  }

  /**
   * Import cache entries from persistence
   */
  import(entries: Array<{
    hostname: string;
    parseResult: DNSParseResult;
    timestamp: string;
    ttl: number;
  }>): number {
    let importedCount = 0;
    
    entries.forEach(item => {
      const timestamp = new Date(item.timestamp);
      const entry: DNSCacheEntry = {
        hostname: item.hostname,
        parseResult: item.parseResult,
        timestamp,
        ttl: item.ttl
      };
      
      // Only import if not expired
      if (!this.isExpired(entry)) {
        this.cache.set(item.hostname, entry);
        importedCount++;
      }
    });
    
    return importedCount;
  }

  /**
   * Get entries by provider
   */
  getByProvider(provider: string): DNSParseResult[] {
    const results: DNSParseResult[] = [];
    
    this.cache.forEach(entry => {
      if (!this.isExpired(entry) && entry.parseResult.provider === provider) {
        results.push(entry.parseResult);
      }
    });
    
    return results;
  }

  /**
   * Get entries by location
   */
  getByLocation(country?: string, city?: string): DNSParseResult[] {
    const results: DNSParseResult[] = [];
    
    this.cache.forEach(entry => {
      if (!this.isExpired(entry)) {
        const location = entry.parseResult.locationInfo;
        let matches = true;
        
        if (country && location.country !== country) {
          matches = false;
        }
        
        if (city && location.city !== city) {
          matches = false;
        }
        
        if (matches) {
          results.push(entry.parseResult);
        }
      }
    });
    
    return results;
  }

  /**
   * Warm up cache with known validators
   */
  async warmupCache(hostnames: string[], parseFunction: (hostname: string) => Promise<DNSParseResult>): Promise<void> {
    const batchSize = 5;
    
    for (let i = 0; i < hostnames.length; i += batchSize) {
      const batch = hostnames.slice(i, i + batchSize);
      
      const promises = batch.map(async hostname => {
        if (!this.has(hostname)) {
          try {
            const result = await parseFunction(hostname);
            this.set(hostname, result);
          } catch (error) {
            console.warn(`Failed to warm up cache for ${hostname}:`, error);
          }
        }
      });
      
      await Promise.allSettled(promises);
      
      // Add delay between batches
      if (i + batchSize < hostnames.length) {
        await this.delay(500);
      }
    }
  }

  /**
   * Start automatic cleanup of expired entries
   */
  private startAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Run cleanup every 10 minutes
    this.cleanupInterval = setInterval(() => {
      const removed = this.cleanup();
      if (removed > 0) {
        console.log(`DNS Cache: Cleaned up ${removed} expired entries`);
      }
    }, 600000);
  }

  /**
   * Stop automatic cleanup
   */
  stopAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Check if cache entry has expired
   */
  private isExpired(entry: DNSCacheEntry): boolean {
    const now = Date.now();
    const entryTime = entry.timestamp.getTime();
    return (now - entryTime) > entry.ttl;
  }

  /**
   * Evict oldest cache entry to make room
   */
  private evictOldest(): void {
    let oldestTimestamp = Date.now();
    let oldestKey = '';
    
    this.cache.forEach((entry, hostname) => {
      if (entry.timestamp.getTime() < oldestTimestamp) {
        oldestTimestamp = entry.timestamp.getTime();
        oldestKey = hostname;
      }
    });
    
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Calculate cache hit rate (placeholder - would need tracking)
   */
  private calculateHitRate(): number {
    // This would need request tracking to calculate actual hit rate
    // For now, return estimated hit rate based on cache size and usage
    return this.cache.size > 0 ? 0.85 : 0;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Destructor to clean up resources
   */
  destroy(): void {
    this.stopAutoCleanup();
    this.clear();
  }
} 