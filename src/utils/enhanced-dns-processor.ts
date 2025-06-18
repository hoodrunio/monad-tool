import { IntelligentDNSParser } from './dns-parser';
import { NetworkDiscoveryService } from './network-discovery';
import { DNSCacheManager } from './dns-cache';
import { DNSParseResult, ValidatorInfo, NetworkDiscoveryResult } from './types';

/**
 * Enhanced DNS Processor that integrates all DNS utilities
 * for use in the Monad log processing pipeline
 */
export class EnhancedDNSProcessor {
  private dnsParser: IntelligentDNSParser;
  private networkDiscovery: NetworkDiscoveryService;
  private cacheManager: DNSCacheManager;
  private validatorRegistry: Map<string, ValidatorInfo> = new Map();

  constructor(options?: {
    cacheOptions?: {
      defaultTTL?: number;
      maxCacheSize?: number;
      enableAutoCleanup?: boolean;
    };
  }) {
    this.dnsParser = new IntelligentDNSParser();
    this.networkDiscovery = new NetworkDiscoveryService();
    this.cacheManager = new DNSCacheManager(options?.cacheOptions);
  }

  /**
   * Process validator DNS address with intelligent parsing and caching
   */
  async processValidatorDNS(dnsAddress: string, validatorId?: string): Promise<DNSParseResult> {
    const hostname = dnsAddress.split(':')[0];
    
    // Check cache first
    const cached = this.cacheManager.get(hostname);
    if (cached) {
      return cached;
    }

    // Parse DNS with external services
    const parseResult = await this.dnsParser.parse(dnsAddress);
    
    // Cache the result
    this.cacheManager.set(hostname, parseResult);
    
    // Update validator registry if validator ID provided
    if (validatorId) {
      this.updateValidatorRegistry(validatorId, parseResult);
    }

    return parseResult;
  }

  /**
   * Process multiple validator DNS addresses in batch
   */
  async processBatchValidatorDNS(
    validators: Array<{ dnsAddress: string; validatorId?: string }>
  ): Promise<DNSParseResult[]> {
    const results: DNSParseResult[] = [];
    const batchSize = 5; // Process in small batches to avoid overwhelming external services
    
    for (let i = 0; i < validators.length; i += batchSize) {
      const batch = validators.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async validator => {
        try {
          return await this.processValidatorDNS(validator.dnsAddress, validator.validatorId);
        } catch (error) {
          console.warn(`Failed to process DNS ${validator.dnsAddress}:`, error);
          return null;
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      });
      
      // Add delay between batches
      if (i + batchSize < validators.length) {
        await this.delay(1000);
      }
    }
    
    return results;
  }

  /**
   * Get comprehensive validator information including DNS analysis
   */
  async getValidatorInfo(validatorId: string): Promise<ValidatorInfo | null> {
    return this.validatorRegistry.get(validatorId) || null;
  }

  /**
   * Get all validators for a specific provider
   */
  getValidatorsByProvider(provider: string): ValidatorInfo[] {
    return Array.from(this.validatorRegistry.values())
      .filter(validator => validator.provider === provider);
  }

  /**
   * Get all validators in a specific location
   */
  getValidatorsByLocation(country?: string, city?: string): ValidatorInfo[] {
    return Array.from(this.validatorRegistry.values())
      .filter(validator => {
        const location = validator.locationInfo;
        let matches = true;
        
        if (country && location.country !== country) {
          matches = false;
        }
        
        if (city && location.city !== city) {
          matches = false;
        }
        
        return matches;
      });
  }

  /**
   * Analyze network topology for all registered validators
   */
  async analyzeNetworkTopology(): Promise<NetworkDiscoveryResult> {
    const dnsAddresses = Array.from(this.validatorRegistry.values())
      .map(validator => validator.dnsAddress);
    
    return await this.networkDiscovery.discoverNetwork(dnsAddresses);
  }

  /**
   * Get network centralization risks
   */
  async getCentralizationRisks(): Promise<{
    providerRisk: number;
    geographicRisk: number;
    datacenterRisk: number;
    overallRisk: 'low' | 'medium' | 'high';
    riskFactors: string[];
  }> {
    const networkResult = await this.analyzeNetworkTopology();
    const baseRisks = this.networkDiscovery.analyzeCentralizationRisks(networkResult);
    
    // Identify specific risk factors
    const riskFactors: string[] = [];
    
    // Check for provider concentration
    const totalValidators = networkResult.totalValidators;
    networkResult.providerDistribution.forEach((count, provider) => {
      const percentage = (count / totalValidators) * 100;
      if (percentage > 30) {
        riskFactors.push(`${provider} controls ${percentage.toFixed(1)}% of validators`);
      }
    });
    
    // Check for geographic concentration
    networkResult.geographicDistribution.forEach((count, location) => {
      const percentage = (count / totalValidators) * 100;
      if (percentage > 40) {
        riskFactors.push(`${percentage.toFixed(1)}% of validators in ${location}`);
      }
    });
    
    // Check for datacenter concentration
    networkResult.datacenterDistribution.forEach((count, datacenter) => {
      const percentage = (count / totalValidators) * 100;
      if (percentage > 25) {
        riskFactors.push(`${percentage.toFixed(1)}% of validators on ${datacenter}`);
      }
    });
    
    return {
      ...baseRisks,
      riskFactors
    };
  }

  /**
   * Export validator network data for analytics
   */
  exportNetworkData(): {
    validators: ValidatorInfo[];
    networkTopology: any;
    cacheStats: any;
  } {
    const validators = Array.from(this.validatorRegistry.values());
    
    return {
      validators,
      networkTopology: null, // Would be populated after network analysis
      cacheStats: this.cacheManager.getStats()
    };
  }

  /**
   * Warm up the DNS cache with known validators
   */
  async warmupCache(dnsAddresses: string[]): Promise<void> {
    await this.cacheManager.warmupCache(
      dnsAddresses.map(addr => addr.split(':')[0]),
      async (hostname) => {
        return await this.dnsParser.parse(`${hostname}:8000`);
      }
    );
  }

  /**
   * Get DNS cache statistics
   */
  getCacheStats(): {
    totalEntries: number;
    validEntries: number;
    expiredEntries: number;
    hitRate: number;
    memoryUsage: number;
  } {
    return this.cacheManager.getStats();
  }

  /**
   * Clear DNS cache
   */
  clearCache(): void {
    this.cacheManager.clear();
  }

  /**
   * Update validator registry with new DNS information
   */
  private updateValidatorRegistry(validatorId: string, parseResult: DNSParseResult): void {
    const validatorInfo: ValidatorInfo = {
      validatorId,
      dnsAddress: parseResult.originalAddress,
      provider: parseResult.provider,
      locationInfo: parseResult.locationInfo,
      lastSeen: new Date(),
      status: 'active' // This would be determined by actual validator activity
    };
    
    this.validatorRegistry.set(validatorId, validatorInfo);
  }

  /**
   * Utility delay function
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.cacheManager.destroy();
  }
}

/**
 * Factory function to create EnhancedDNSProcessor with default settings
 */
export function createEnhancedDNSProcessor(): EnhancedDNSProcessor {
  return new EnhancedDNSProcessor({
    cacheOptions: {
      defaultTTL: 3600000, // 1 hour
      maxCacheSize: 10000,
      enableAutoCleanup: true
    }
  });
}

/**
 * Utility function to extract provider name from validator DNS
 * Uses the intelligent parser for consistent results
 */
export async function extractProviderFromDNS(dnsAddress: string): Promise<string> {
  const parser = new IntelligentDNSParser();
  try {
    const result = await parser.parse(dnsAddress);
    return result.provider;
  } catch (error) {
    console.warn(`Failed to extract provider from ${dnsAddress}:`, error);
    
    // Fallback to simple domain extraction
    const hostname = dnsAddress.split(':')[0];
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    return 'unknown';
  }
} 