import { IDnsCache } from '../interfaces/IDnsCache';
import { DnsResolutionResult, DnsCacheEntry } from '../types';

export class DnsCache implements IDnsCache {
  private cache = new Map<string, DnsCacheEntry>();
  private readonly defaultTtl: number;
  private readonly maxEntries: number;
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor(
    defaultTtl: number = 24 * 60 * 60 * 1000, // 24 hours
    maxEntries: number = 5000,
    enableAutoCleanup: boolean = true
  ) {
    this.defaultTtl = defaultTtl;
    this.maxEntries = maxEntries;
    
    if (enableAutoCleanup) {
      this.startAutoCleanup();
    }
  }
  
  get(hostname: string): DnsResolutionResult | null {
    const entry = this.cache.get(hostname.toLowerCase());
    
    if (!entry) {
      return null;
    }
    
    if (this.isExpired(entry)) {
      this.cache.delete(hostname.toLowerCase());
      return null;
    }
    
    return entry.result;
  }
  
  set(hostname: string, result: DnsResolutionResult, ttl?: number): void {
    // Enforce cache size limit
    if (this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }
    
    const entry: DnsCacheEntry = {
      result: {
        ...result,
        hostname: hostname.toLowerCase()
      },
      cachedAt: new Date(),
      ttl: ttl || this.defaultTtl
    };
    
    this.cache.set(hostname.toLowerCase(), entry);
  }
  
  has(hostname: string): boolean {
    const entry = this.cache.get(hostname.toLowerCase());
    return entry ? !this.isExpired(entry) : false;
  }
  
  delete(hostname: string): boolean {
    return this.cache.delete(hostname.toLowerCase());
  }
  
  clear(): void {
    this.cache.clear();
  }
  
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
  
  getStats(): {
    totalEntries: number;
    validEntries: number;
    expiredEntries: number;
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
    
    // Rough memory usage estimation
    const memoryUsage = this.cache.size * 300; // ~300 bytes per entry
    
    return {
      totalEntries: this.cache.size,
      validEntries,
      expiredEntries,
      memoryUsage
    };
  }
  
  private isExpired(entry: DnsCacheEntry): boolean {
    const now = Date.now();
    const entryTime = entry.cachedAt.getTime();
    return (now - entryTime) > entry.ttl;
  }
  
  private evictOldest(): void {
    let oldestTime = Date.now();
    let oldestKey = '';
    
    this.cache.forEach((entry, hostname) => {
      if (entry.cachedAt.getTime() < oldestTime) {
        oldestTime = entry.cachedAt.getTime();
        oldestKey = hostname;
      }
    });
    
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
  
  private startAutoCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Run cleanup every 15 minutes
    this.cleanupInterval = setInterval(() => {
      const removed = this.cleanup();
      if (removed > 0) {
        console.log(`DnsCache: Cleaned up ${removed} expired entries`);
      }
    }, 900000);
  }
  
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
} 