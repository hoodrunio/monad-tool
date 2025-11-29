import { IGeolocationService } from './interfaces/IGeolocationService';
import { IGeolocationProvider } from './interfaces/IGeolocationProvider';
import { IGeolocationCache } from './interfaces/IGeolocationCache';
import { GeolocationData, GeolocationStats, GeolocationServiceConfig } from './types';
import { IpApiProvider } from './providers/IpApiProvider';
import { GeolocationCache } from './cache/GeolocationCache';

export class GeolocationService implements IGeolocationService {
  private readonly provider: IGeolocationProvider;
  private readonly cache: IGeolocationCache;
  private readonly config: GeolocationServiceConfig;
  
  // Statistics tracking
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private apiCalls = 0;
  private batchApiCalls = 0;
  private errors = 0;
  
  constructor(
    provider?: IGeolocationProvider,
    cache?: IGeolocationCache,
    config?: Partial<GeolocationServiceConfig>
  ) {
    this.config = {
      cacheConfig: {
        defaultTtl: 24 * 60 * 60 * 1000, // 24 hours
        maxEntries: 10000,
        cleanupInterval: 600000, // 10 minutes
      },
      rateLimitConfig: {
        requestsPerMinute: 45,
        burstLimit: 5,
        backoffMultiplier: 1.5,
      },
      ...config
    };
    
    this.provider = provider || new IpApiProvider();
    this.cache = cache || new GeolocationCache(
      this.config.cacheConfig.defaultTtl,
      this.config.cacheConfig.maxEntries,
      true
    );
  }
  
  async getLocationForIp(ip: string): Promise<GeolocationData | null> {
    this.totalRequests++;
    
    // Validate IP format
    if (!this.isValidIp(ip)) {
      this.errors++;
      return null;
    }
    
    // Check cache first
    const cached = this.cache.get(ip);
    if (cached) {
      this.cacheHits++;
      return cached;
    }
    
    this.cacheMisses++;
    
    // Make API call
    try {
      const response = await this.provider.getLocation(ip);
      this.apiCalls++;
      
      if (!response.success) {
        this.errors++;
        
        // If rate limited, wait and retry once
        if (response.rateLimited) {
          await this.delay(2000);
          const retryResponse = await this.provider.getLocation(ip);
          if (retryResponse.success && retryResponse.data) {
            this.cache.set(ip, retryResponse.data);
            return retryResponse.data;
          }
        }
        
        return null;
      }
      
      if (response.data) {
        // Cache successful result
        this.cache.set(ip, response.data);
        return response.data;
      }
      
      return null;
      
    } catch (error) {
      this.errors++;
      console.warn(`Geolocation lookup failed for IP ${ip}:`, error);
      return null;
    }
  }
  
  async getLocationsForIps(ips: string[]): Promise<Map<string, GeolocationData>> {
    const results = new Map<string, GeolocationData>();
    const batchSize = 5; // Process in small batches to respect rate limits
    
    for (let i = 0; i < ips.length; i += batchSize) {
      const batch = ips.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (ip) => {
        const location = await this.getLocationForIp(ip);
        return { ip, location };
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.location) {
          results.set(result.value.ip, result.value.location);
        }
      });
      
      // Add delay between batches to respect rate limits
      if (i + batchSize < ips.length) {
        await this.delay(1500); // 1.5 seconds between batches
      }
    }
    
    return results;
  }

  /**
   * EFFICIENT BATCH PROCESSING using ip-api.com batch API
   * 
   * This method is ideal for validator initialization as it can process
   * up to 100 IPs per request, dramatically reducing API calls and time.
   * 
   * Example: 169 validators = 2 batch requests instead of 169 individual requests
   */
  async getLocationsBatch(ips: string[]): Promise<Map<string, GeolocationData>> {
    console.log(`🚀 Starting batch geolocation for ${ips.length} IPs...`);
    
    const results = new Map<string, GeolocationData>();
    const validIps: string[] = [];
    
    // Filter valid IPs and check cache
    for (const ip of ips) {
      this.totalRequests++;
      
      if (!this.isValidIp(ip)) {
        this.errors++;
        continue;
      }
      
      // Check cache first
      const cached = this.cache.get(ip);
      if (cached) {
        this.cacheHits++;
        results.set(ip, cached);
      } else {
        this.cacheMisses++;
        validIps.push(ip);
      }
    }
    
    console.log(`📊 Cache check: ${results.size} hits, ${validIps.length} need lookup`);
    
    if (validIps.length === 0) {
      console.log('✅ All IPs found in cache, no API calls needed');
      return results;
    }
    
    // Use batch API for remaining IPs
    try {
      // Check if provider supports batch (IpApiProvider does)
      if ('getLocationsBatch' in this.provider) {
        console.log('📡 Using ip-api.com batch API for efficient processing...');
        
        const batchResults = await (this.provider as any).getLocationsBatch(validIps);
        this.batchApiCalls++;
        
        // Process batch results
        batchResults.forEach((response: any, ip: string) => {
          if (response.success && response.data) {
            // Cache the successful result
            this.cache.set(ip, response.data);
            results.set(ip, response.data);
          } else {
            this.errors++;
            console.warn(`Failed to get location for ${ip}: ${response.error}`);
          }
        });
        
        console.log(`✅ Batch processing complete: ${batchResults.size} results processed`);
        
      } else {
        // Fallback to sequential processing
        console.warn('⚠️ Provider does not support batch API, falling back to sequential processing');
        const sequentialResults = await this.getLocationsForIps(validIps);
        sequentialResults.forEach((data, ip) => results.set(ip, data));
      }
      
    } catch (error) {
      console.error('❌ Batch geolocation failed:', error);
      this.errors++;
    }
    
    console.log(`🎉 Batch geolocation complete: ${results.size}/${ips.length} successful`);
    return results;
  }
  
  getStats(): GeolocationStats {
    const providerStats = this.provider.getStats();
    const cacheStats = this.cache.getStats();
    
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      apiCalls: this.apiCalls + this.batchApiCalls,
      errors: this.errors,
      rateLimitHits: providerStats.rateLimitHits,
      avgResponseTime: providerStats.avgResponseTime,
      hitRate: this.totalRequests > 0 ? (this.cacheHits / this.totalRequests) * 100 : 0
    };
  }
  
  clearCache(): void {
    this.cache.clear();
  }
  
  cleanupCache(): number {
    return this.cache.cleanup();
  }
  
  private isValidIp(ip: string): boolean {
    // Basic IPv4 validation
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    
    // Basic IPv6 validation (simplified)
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
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
    this.apiCalls = 0;
    this.batchApiCalls = 0;
    this.errors = 0;
    this.provider.resetStats();
  }
  
  /**
   * Get detailed performance metrics
   */
  getPerformanceMetrics(): {
    hitRate: number;
    errorRate: number;
    avgResponseTime: number;
    cacheEfficiency: string;
    rateLimitUtilization: number;
    batchEfficiency: string;
  } {
    const stats = this.getStats();
    const errorRate = this.totalRequests > 0 ? (this.errors / this.totalRequests) * 100 : 0;
    
    let cacheEfficiency: string;
    if (stats.hitRate >= 90) cacheEfficiency = 'excellent';
    else if (stats.hitRate >= 80) cacheEfficiency = 'good';
    else if (stats.hitRate >= 70) cacheEfficiency = 'fair';
    else cacheEfficiency = 'poor';
    
    let batchEfficiency: string;
    if (this.batchApiCalls > this.apiCalls) batchEfficiency = 'excellent';
    else if (this.batchApiCalls > 0) batchEfficiency = 'good';
    else batchEfficiency = 'not-used';
    
    // Estimate rate limit utilization (requests per minute)
    const rateLimitUtilization = (this.apiCalls / this.config.rateLimitConfig.requestsPerMinute) * 100;
    
    return {
      hitRate: stats.hitRate,
      errorRate,
      avgResponseTime: stats.avgResponseTime,
      cacheEfficiency,
      rateLimitUtilization: Math.min(rateLimitUtilization, 100),
      batchEfficiency
    };
  }
} 