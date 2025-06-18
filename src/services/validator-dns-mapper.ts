import { ValidatorRegistry, DNSMapping } from './validator-registry';
import { EnhancedDNSProcessor } from '../utils/enhanced-dns-processor';
import { IntelligentDNSParser } from '../utils/dns-parser';

export interface ValidatorDNSInfo {
  nodeId: string;
  dnsAddress: string;
  provider?: string;
  location?: string;
  lastSeen: Date;
  processedCount: number;
}

/**
 * Service to manage validator DNS mappings and reduce redundant DNS lookups
 */
export class ValidatorDNSMapperService {
  private validatorRegistry: ValidatorRegistry;
  private dnsProcessor: EnhancedDNSProcessor;
  private dnsParser: IntelligentDNSParser;
  private validatorDNSInfo: Map<string, ValidatorDNSInfo> = new Map();
  private dnsCacheExpiry: number = 24 * 60 * 60 * 1000; // 24 hours

  constructor(validatorRegistry: ValidatorRegistry) {
    this.validatorRegistry = validatorRegistry;
    this.dnsProcessor = new EnhancedDNSProcessor();
    this.dnsParser = new IntelligentDNSParser();
  }

  /**
   * Initialize DNS mappings from existing data and validators.toml
   */
  async initialize(): Promise<void> {
    await this.validatorRegistry.initialize();
    console.log('✅ Validator DNS Mapper initialized');
  }

  /**
   * Get or resolve DNS information for a validator
   */
  async getValidatorDNS(nodeId: string, dnsAddress?: string): Promise<ValidatorDNSInfo | null> {
    // Check if we have cached info that's still fresh
    const cached = this.validatorDNSInfo.get(nodeId);
    if (cached && this.isCacheValid(cached)) {
      cached.processedCount++;
      cached.lastSeen = new Date();
      return cached;
    }

    // If no DNS address provided, try to get from registry
    if (!dnsAddress) {
      const registryDNS = this.validatorRegistry.getValidatorDNS(nodeId);
      dnsAddress = registryDNS || undefined;
    }

    if (!dnsAddress) {
      console.warn(`No DNS address available for validator ${nodeId}`);
      return null;
    }

    try {
      // Only process DNS if we don't have recent cache or it's a new address
      const shouldProcessDNS = !cached || cached.dnsAddress !== dnsAddress;
      
      let provider: string | undefined;
      let location: string | undefined;

      if (shouldProcessDNS) {
        const parseResult = await this.dnsParser.parse(dnsAddress);
        provider = parseResult.provider;
        location = parseResult.locationInfo.country;
      } else {
        provider = cached.provider;
        location = cached.location;
      }

      const dnsInfo: ValidatorDNSInfo = {
        nodeId,
        dnsAddress,
        provider,
        location,
        lastSeen: new Date(),
        processedCount: (cached?.processedCount || 0) + 1
      };

      // Update caches
      this.validatorDNSInfo.set(nodeId, dnsInfo);
      this.validatorRegistry.setValidatorDNS(nodeId, dnsAddress, provider, location);

      return dnsInfo;
    } catch (error) {
      console.warn(`Failed to process DNS for validator ${nodeId}:`, error);
      return null;
    }
  }

  /**
   * Batch process multiple validator DNS addresses
   */
  async batchProcessValidatorDNS(
    validators: Array<{ nodeId: string; dnsAddress?: string }>
  ): Promise<ValidatorDNSInfo[]> {
    const results: ValidatorDNSInfo[] = [];
    const batchSize = 3; // Smaller batches to be conservative with external APIs

    for (let i = 0; i < validators.length; i += batchSize) {
      const batch = validators.slice(i, i + batchSize);
      const batchPromises = batch.map(validator => 
        this.getValidatorDNS(validator.nodeId, validator.dnsAddress)
      );

      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      });

      // Add delay between batches to respect rate limits
      if (i + batchSize < validators.length) {
        await this.delay(2000); // 2 second delay
      }
    }

    return results;
  }

  /**
   * Extract unique DNS addresses from log batch to avoid redundant processing
   */
  extractUniqueDNSFromLogs(logs: any[]): Array<{ nodeId: string; dnsAddress: string }> {
    const dnsMap = new Map<string, string>(); // nodeId -> dnsAddress
    
    for (const log of logs) {
      if (log.parsed?.dns_address && log.parsed?.validator_id) {
        const nodeId = log.parsed.validator_id;
        const dnsAddress = log.parsed.dns_address;
        
        // Only add if we haven't seen this DNS address recently
        const cached = this.validatorDNSInfo.get(nodeId);
        if (!cached || !this.isCacheValid(cached) || cached.dnsAddress !== dnsAddress) {
          dnsMap.set(nodeId, dnsAddress);
        }
      }
    }

    return Array.from(dnsMap.entries()).map(([nodeId, dnsAddress]) => ({
      nodeId,
      dnsAddress
    }));
  }

  /**
   * Get statistics about DNS processing
   */
  getStats(): {
    totalValidators: number;
    processedValidators: number;
    totalProcessingCount: number;
    averageProcessingPerValidator: number;
    cacheHitRate: number;
  } {
    const validatorInfos = Array.from(this.validatorDNSInfo.values());
    const totalProcessingCount = validatorInfos.reduce((sum, info) => sum + info.processedCount, 0);
    const registryStats = this.validatorRegistry.getDNSMappingStats();

    return {
      totalValidators: registryStats.totalValidators,
      processedValidators: validatorInfos.length,
      totalProcessingCount,
      averageProcessingPerValidator: validatorInfos.length > 0 
        ? totalProcessingCount / validatorInfos.length 
        : 0,
      cacheHitRate: registryStats.coveragePercentage
    };
  }

  /**
   * Force refresh DNS info for a validator
   */
  async forceRefreshValidator(nodeId: string, dnsAddress: string): Promise<ValidatorDNSInfo | null> {
    // Remove from cache to force fresh lookup
    this.validatorDNSInfo.delete(nodeId);
    return await this.getValidatorDNS(nodeId, dnsAddress);
  }

  /**
   * Clean up expired cache entries
   */
  cleanupExpiredCache(): void {
    const now = new Date();
    for (const [nodeId, info] of this.validatorDNSInfo.entries()) {
      if (now.getTime() - info.lastSeen.getTime() > this.dnsCacheExpiry) {
        this.validatorDNSInfo.delete(nodeId);
      }
    }
  }

  /**
   * Check if cached DNS info is still valid
   */
  private isCacheValid(info: ValidatorDNSInfo): boolean {
    const now = new Date();
    return now.getTime() - info.lastSeen.getTime() < this.dnsCacheExpiry;
  }

  /**
   * Utility delay function
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
} 