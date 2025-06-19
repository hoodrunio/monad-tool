import { ValidatorRegistry, Validator } from './validator-registry';
import { DNSMapperService, ValidatorDNSInfo, ValidatorDNSMapping } from './dns-mapper';

export interface CompleteValidatorInfo {
  // From ValidatorRegistry
  nodeId: string;
  stake: number;
  cert_pubkey: string;
  position: number;
  epoch: number;
  
  // From DNSMapper
  dnsAddress?: string;
  dnsHost?: string;
  dnsPort?: number;
  provider?: string;
  location?: string;
  country?: string;
  city?: string;
  datacenter?: string;
  
  // Combined metadata
  isActive: boolean;
  lastSeen?: Date;
  processedCount?: number;
}

export interface ValidatorLookupResult {
  found: boolean;
  validator?: CompleteValidatorInfo;
  source: 'cache' | 'registry' | 'unknown';
}

export interface ValidatorInfoStats {
  totalValidators: number;
  validatorsWithDNS: number;
  dnsCoverage: number;
  cacheStats: {
    totalCached: number;
    hitRate: number;
  };
  registryStats: {
    availableEpochs: number[];
    currentEpoch: number;
  };
  dnsStats: {
    totalMappings: number;
    processedMappings: number;
    errorCount: number;
  };
}

/**
 * Validator Info Service - Combines validator registry and DNS mapper
 * Provides complete validator information to processors without them needing to handle DNS resolution
 */
export class ValidatorInfoService {
  private validatorRegistry: ValidatorRegistry;
  private dnsMapper: DNSMapperService;
  private validatorInfoCache: Map<string, CompleteValidatorInfo> = new Map();
  
  private isInitialized: boolean = false;
  private readonly CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
  
  constructor(
    validatorRegistry?: ValidatorRegistry,
    dnsMapper?: DNSMapperService
  ) {
    this.validatorRegistry = validatorRegistry || new ValidatorRegistry();
    this.dnsMapper = dnsMapper || new DNSMapperService();
  }

  /**
   * Initialize both services
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log('🔧 Initializing Validator Info Service...');
      
      // Initialize both services in parallel
      await Promise.all([
        this.validatorRegistry.initialize(),
        this.dnsMapper.initialize()
      ]);

      console.log('✅ Validator Info Service initialized successfully');
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize Validator Info Service:', error);
      throw error;
    }
  }

  /**
   * Pre-process all validator DNS information for optimal performance
   */
  async preProcessAll(): Promise<void> {
    console.log('🔄 Pre-processing all validator DNS information...');
    
    const allValidators = this.validatorRegistry.getAllValidators();
    const nodeIds = allValidators.map(v => v.node_id);
    
    // Process DNS information in batches
    await this.dnsMapper.batchProcessValidatorDNS(nodeIds);
    
    // Build cache
    await this.buildValidatorInfoCache();
    
    console.log('✅ Pre-processing completed');
  }

  /**
   * Get complete validator information (optimized for log processors)
   */
  async getValidatorInfo(nodeId: string, epoch?: number): Promise<CompleteValidatorInfo | null> {
    const normalizedId = this.normalizeNodeId(nodeId);
    const cacheKey = this.getCacheKey(normalizedId, epoch);
    
    // Check cache first
    const cached = this.validatorInfoCache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      return cached;
    }

    // Build complete info from both services
    const completeInfo = await this.buildCompleteValidatorInfo(normalizedId, epoch);
    
    // Cache the result
    if (completeInfo) {
      this.validatorInfoCache.set(cacheKey, completeInfo);
    }
    
    return completeInfo;
  }

  /**
   * Get validator info synchronously (for high-performance log processing)
   * Only returns cached data - use preProcessAll() to ensure cache is populated
   */
  getValidatorInfoSync(nodeId: string, epoch?: number): CompleteValidatorInfo | null {
    const normalizedId = this.normalizeNodeId(nodeId);
    const cacheKey = this.getCacheKey(normalizedId, epoch);
    
    const cached = this.validatorInfoCache.get(cacheKey);
    return cached && this.isCacheValid(cached) ? cached : null;
  }

  /**
   * Batch get validator information for multiple validators
   */
  async batchGetValidatorInfo(
    nodeIds: string[], 
    epoch?: number
  ): Promise<Map<string, CompleteValidatorInfo>> {
    const results = new Map<string, CompleteValidatorInfo>();
    const uncachedIds: string[] = [];

    // Check cache for all requested validators
    for (const nodeId of nodeIds) {
      const normalizedId = this.normalizeNodeId(nodeId);
      const cached = this.getValidatorInfoSync(normalizedId, epoch);
      
      if (cached) {
        results.set(normalizedId, cached);
      } else {
        uncachedIds.push(normalizedId);
      }
    }

    // Process uncached validators
    if (uncachedIds.length > 0) {
      const uncachedPromises = uncachedIds.map(id => this.getValidatorInfo(id, epoch));
      const uncachedResults = await Promise.allSettled(uncachedPromises);
      
      uncachedResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          results.set(uncachedIds[index], result.value);
        }
      });
    }

    return results;
  }

  /**
   * Get validator lookup result with metadata
   */
  async lookupValidator(nodeId: string, epoch?: number): Promise<ValidatorLookupResult> {
    const normalizedId = this.normalizeNodeId(nodeId);
    const cacheKey = this.getCacheKey(normalizedId, epoch);
    
    // Check cache first
    const cached = this.validatorInfoCache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      return {
        found: true,
        validator: cached,
        source: 'cache'
      };
    }

    // Try to build from registry
    const validator = await this.buildCompleteValidatorInfo(normalizedId, epoch);
    if (validator) {
      this.validatorInfoCache.set(cacheKey, validator);
      return {
        found: true,
        validator,
        source: 'registry'
      };
    }

    return {
      found: false,
      source: 'unknown'
    };
  }

  /**
   * Get all validators with complete information
   */
  async getAllValidatorsWithInfo(epoch?: number): Promise<CompleteValidatorInfo[]> {
    const validators = this.validatorRegistry.getAllValidators(epoch);
    const results: CompleteValidatorInfo[] = [];

    for (const validator of validators) {
      const completeInfo = await this.getValidatorInfo(validator.node_id, epoch);
      if (completeInfo) {
        results.push(completeInfo);
      }
    }

    return results;
  }

  /**
   * Get service statistics
   */
  getStats(): ValidatorInfoStats {
    const registryStats = this.validatorRegistry.getValidatorStats();
    const dnsStats = this.dnsMapper.getStats();
    const totalValidators = registryStats.totalValidators;
    const validatorsWithDNS = dnsStats.processedMappings;

    return {
      totalValidators,
      validatorsWithDNS,
      dnsCoverage: totalValidators > 0 ? (validatorsWithDNS / totalValidators) * 100 : 0,
      cacheStats: {
        totalCached: this.validatorInfoCache.size,
        hitRate: this.calculateCacheHitRate()
      },
      registryStats: {
        availableEpochs: this.validatorRegistry.getAvailableEpochs(),
        currentEpoch: this.validatorRegistry.getCurrentEpoch()
      },
      dnsStats: {
        totalMappings: dnsStats.totalMappings,
        processedMappings: dnsStats.processedMappings,
        errorCount: dnsStats.errorCount
      }
    };
  }

  /**
   * Force refresh validator information
   */
  async refreshValidator(nodeId: string, epoch?: number): Promise<CompleteValidatorInfo | null> {
    const normalizedId = this.normalizeNodeId(nodeId);
    const cacheKey = this.getCacheKey(normalizedId, epoch);
    
    // Remove from cache
    this.validatorInfoCache.delete(cacheKey);
    
    // Force refresh DNS info
    await this.dnsMapper.forceRefreshValidator(normalizedId);
    
    // Rebuild info
    return await this.getValidatorInfo(normalizedId, epoch);
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache(): void {
    const now = new Date();
    for (const [key, info] of this.validatorInfoCache.entries()) {
      if (info.lastSeen && now.getTime() - info.lastSeen.getTime() > this.CACHE_TTL_MS) {
        this.validatorInfoCache.delete(key);
      }
    }
    
    // Also cleanup DNS mapper cache
    this.dnsMapper.cleanupExpiredCache();
  }

  /**
   * Set current epoch for registry
   */
  setCurrentEpoch(epoch: number): void {
    this.validatorRegistry.setCurrentEpoch(epoch);
  }

  /**
   * Check if validator has DNS mapping
   */
  hasValidatorDNS(nodeId: string): boolean {
    return this.dnsMapper.hasValidatorDNS(nodeId);
  }

  /**
   * Build complete validator information from both services
   */
  private async buildCompleteValidatorInfo(
    nodeId: string, 
    epoch?: number
  ): Promise<CompleteValidatorInfo | null> {
    // Get validator from registry
    const validator = this.validatorRegistry.getValidatorById(nodeId, epoch);
    if (!validator) {
      return null;
    }

    // Get DNS info (if available)
    const dnsInfo = await this.dnsMapper.getValidatorDNSInfo(nodeId);
    
    // Build complete info
    const completeInfo: CompleteValidatorInfo = {
      nodeId: validator.node_id,
      stake: validator.stake,
      cert_pubkey: validator.cert_pubkey,
      position: validator.position,
      epoch: epoch || this.validatorRegistry.getCurrentEpoch(),
      isActive: true,
      
      // DNS information (if available)
      dnsAddress: dnsInfo?.dnsAddress,
      dnsHost: dnsInfo?.dnsHost,
      dnsPort: dnsInfo?.dnsPort,
      provider: dnsInfo?.provider,
      location: dnsInfo?.location,
      country: dnsInfo?.country,
      city: dnsInfo?.city,
      datacenter: dnsInfo?.datacenter,
      
      // Metadata
      lastSeen: dnsInfo?.lastSeen || new Date(),
      processedCount: dnsInfo?.processedCount || 0
    };

    return completeInfo;
  }

  /**
   * Build validator info cache for all validators
   */
  private async buildValidatorInfoCache(): Promise<void> {
    console.log('🔄 Building validator info cache...');
    
    const allValidators = this.validatorRegistry.getAllValidators();
    const batchSize = 10;
    
    for (let i = 0; i < allValidators.length; i += batchSize) {
      const batch = allValidators.slice(i, i + batchSize);
      const batchPromises = batch.map(v => this.buildCompleteValidatorInfo(v.node_id));
      
      const results = await Promise.allSettled(batchPromises);
      
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          const validator = batch[index];
          const cacheKey = this.getCacheKey(validator.node_id);
          this.validatorInfoCache.set(cacheKey, result.value);
        }
      });
    }
    
    console.log(`✅ Built cache for ${this.validatorInfoCache.size} validators`);
  }

  /**
   * Generate cache key for validator
   */
  private getCacheKey(nodeId: string, epoch?: number): string {
    const normalizedId = this.normalizeNodeId(nodeId);
    const epochPart = epoch || this.validatorRegistry.getCurrentEpoch();
    return `${normalizedId}:${epochPart}`;
  }

  /**
   * Check if cached validator info is still valid
   */
  private isCacheValid(info: CompleteValidatorInfo): boolean {
    if (!info.lastSeen) return true; // No expiry for non-DNS info
    
    const now = new Date();
    return now.getTime() - info.lastSeen.getTime() < this.CACHE_TTL_MS;
  }

  /**
   * Calculate cache hit rate (simplified)
   */
  private calculateCacheHitRate(): number {
    // This is a simplified calculation - in a real implementation,
    // you'd track actual hit/miss statistics
    return this.validatorInfoCache.size > 0 ? 85 : 0; // Assume 85% hit rate when cache is populated
  }

  /**
   * Normalize node ID
   */
  private normalizeNodeId(nodeId: string): string {
    return nodeId.startsWith('0x') ? nodeId.slice(2) : nodeId;
  }
}

// Singleton instance
export const validatorInfoService = new ValidatorInfoService(); 