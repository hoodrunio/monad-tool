import { IDnsService } from './interfaces/IDnsService';
import { IDnsResolver } from './interfaces/IDnsResolver';
import { IDnsCache } from './interfaces/IDnsCache';
import { DnsResolutionResult, DnsStats, DnsServiceConfig } from './types';
import { SystemDnsResolver } from './resolvers/SystemDnsResolver';
import { DnsCache } from './cache/DnsCache';

export class DnsService implements IDnsService {
  private readonly resolver: IDnsResolver;
  private readonly cache: IDnsCache;
  private readonly config: DnsServiceConfig;
  
  // Statistics tracking
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private resolutionAttempts = 0;
  private failures = 0;
  
  constructor(
    resolver?: IDnsResolver,
    cache?: IDnsCache,
    config?: Partial<DnsServiceConfig>
  ) {
    this.config = {
      cacheConfig: {
        defaultTtl: 24 * 60 * 60 * 1000, // 24 hours
        maxEntries: 5000,
        cleanupInterval: 900000, // 15 minutes
      },
      resolverConfig: {
        timeout: 5000,
        retries: 2,
        preferredResolvers: ['8.8.8.8', '1.1.1.1'],
      },
      ...config
    };
    
    this.resolver = resolver || new SystemDnsResolver(
      this.config.resolverConfig.timeout,
      this.config.resolverConfig.retries
    );
    
    this.cache = cache || new DnsCache(
      this.config.cacheConfig.defaultTtl,
      this.config.cacheConfig.maxEntries,
      true
    );
  }
  
  async resolveHostname(hostname: string): Promise<string | null> {
    this.totalRequests++;
    
    // Validate hostname format
    if (!this.isValidHostname(hostname)) {
      this.failures++;
      return null;
    }
    
    // Check cache first
    const cached = this.cache.get(hostname);
    if (cached) {
      this.cacheHits++;
      return cached.ip;
    }
    
    this.cacheMisses++;
    
    // Perform DNS resolution
    try {
      this.resolutionAttempts++;
      const response = await this.resolver.resolve(hostname);
      
      if (!response.success || !response.ip) {
        this.failures++;
        return null;
      }
      
      // Cache successful result
      const result: DnsResolutionResult = {
        hostname,
        ip: response.ip,
        resolvedAt: new Date(),
        ttl: this.config.cacheConfig.defaultTtl
      };
      
      this.cache.set(hostname, result);
      return response.ip;
      
    } catch (error) {
      this.failures++;
      console.warn(`DNS resolution failed for hostname ${hostname}:`, error);
      return null;
    }
  }
  
  async resolveHostnames(hostnames: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const batchSize = 10; // Process in batches to avoid overwhelming the system
    
    for (let i = 0; i < hostnames.length; i += batchSize) {
      const batch = hostnames.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (hostname) => {
        const ip = await this.resolveHostname(hostname);
        return { hostname, ip };
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.ip) {
          results.set(result.value.hostname, result.value.ip);
        }
      });
      
      // Add small delay between batches
      if (i + batchSize < hostnames.length) {
        await this.delay(100);
      }
    }
    
    return results;
  }
  
  async getResolutionResult(hostname: string): Promise<DnsResolutionResult | null> {
    // Check cache first
    const cached = this.cache.get(hostname);
    if (cached) {
      return cached;
    }
    
    // Resolve and return full result
    const ip = await this.resolveHostname(hostname);
    if (!ip) {
      return null;
    }
    
    return this.cache.get(hostname);
  }
  
  getStats(): DnsStats {
    const resolverStats = this.resolver.getStats();
    
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      resolutionAttempts: this.resolutionAttempts,
      failures: this.failures,
      timeouts: resolverStats.timeouts,
      avgResolutionTime: resolverStats.avgResponseTime,
      hitRate: this.totalRequests > 0 ? (this.cacheHits / this.totalRequests) * 100 : 0
    };
  }
  
  clearCache(): void {
    this.cache.clear();
  }
  
  cleanupCache(): number {
    return this.cache.cleanup();
  }
  
  private isValidHostname(hostname: string): boolean {
    // Basic hostname validation
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    
    return hostnameRegex.test(hostname) && hostname.length <= 253;
  }
  
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Reset all statistics
   */
  resetStats(): void {
    this.totalRequests = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.resolutionAttempts = 0;
    this.failures = 0;
    this.resolver.resetStats();
  }
  
  /**
   * Get detailed performance metrics
   */
  getPerformanceMetrics(): {
    hitRate: number;
    failureRate: number;
    avgResolutionTime: number;
    cacheEfficiency: string;
    timeoutRate: number;
  } {
    const stats = this.getStats();
    const failureRate = this.totalRequests > 0 ? (this.failures / this.totalRequests) * 100 : 0;
    const timeoutRate = this.resolutionAttempts > 0 ? (stats.timeouts / this.resolutionAttempts) * 100 : 0;
    
    let cacheEfficiency: string;
    if (stats.hitRate >= 90) cacheEfficiency = 'excellent';
    else if (stats.hitRate >= 80) cacheEfficiency = 'good';
    else if (stats.hitRate >= 70) cacheEfficiency = 'fair';
    else cacheEfficiency = 'poor';
    
    return {
      hitRate: stats.hitRate,
      failureRate,
      avgResolutionTime: stats.avgResolutionTime,
      cacheEfficiency,
      timeoutRate
    };
  }
} 