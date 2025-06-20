import { IGeolocationCache } from '../interfaces/IGeolocationCache';
import { GeolocationData, GeolocationCacheEntry } from '../types';

export class GeolocationCache implements IGeolocationCache {
  private cache = new Map<string, GeolocationCacheEntry>();
  private readonly defaultTtl: number;
  private readonly maxEntries: number;
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor(
    defaultTtl: number = 24 * 60 * 60 * 1000, // 24 hours
    maxEntries: number = 10000,
    enableAutoCleanup: boolean = true
  ) {
    this.defaultTtl = defaultTtl;
    this.maxEntries = maxEntries;
    
    if (enableAutoCleanup) {
      this.startAutoCleanup();
    }
  }
  
  get(ip: string): GeolocationData | null {
    const entry = this.cache.get(ip);
    
    if (!entry) {
      return null;
    }
    
    if (this.isExpired(entry)) {
      this.cache.delete(ip);
      return null;
    }
    
    return entry.data;
  }
  
  set(ip: string, data: GeolocationData, ttl?: number): void {
    // Enforce cache size limit
    if (this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }
    
    const entry: GeolocationCacheEntry = {
      data,
      cachedAt: new Date(),
      ttl: ttl || this.defaultTtl
    };
    
    this.cache.set(ip, entry);
  }
  
  has(ip: string): boolean {
    const entry = this.cache.get(ip);
    return entry ? !this.isExpired(entry) : false;
  }
  
  delete(ip: string): boolean {
    return this.cache.delete(ip);
  }
  
  clear(): void {
    this.cache.clear();
  }
  
  cleanup(): number {
    let removedCount = 0;
    const toRemove: string[] = [];
    
    this.cache.forEach((entry, ip) => {
      if (this.isExpired(entry)) {
        toRemove.push(ip);
      }
    });
    
    toRemove.forEach(ip => {
      this.cache.delete(ip);
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
    const memoryUsage = this.cache.size * 500; // ~500 bytes per entry
    
    return {
      totalEntries: this.cache.size,
      validEntries,
      expiredEntries,
      memoryUsage
    };
  }
  
  private isExpired(entry: GeolocationCacheEntry): boolean {
    const now = Date.now();
    const entryTime = entry.cachedAt.getTime();
    return (now - entryTime) > entry.ttl;
  }
  
  private evictOldest(): void {
    let oldestTime = Date.now();
    let oldestKey = '';
    
    this.cache.forEach((entry, ip) => {
      if (entry.cachedAt.getTime() < oldestTime) {
        oldestTime = entry.cachedAt.getTime();
        oldestKey = ip;
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
    
    // Run cleanup every 10 minutes
    this.cleanupInterval = setInterval(() => {
      const removed = this.cleanup();
      if (removed > 0) {
        console.log(`GeolocationCache: Cleaned up ${removed} expired entries`);
      }
    }, 600000);
  }
  
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
} 