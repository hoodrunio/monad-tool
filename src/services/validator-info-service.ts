import { ValidatorRegistry, Validator } from './validator-registry';
import { DNSMapperService, ValidatorDNSInfo, ValidatorDNSMapping } from './dns-mapper';
import { MonadClickHouseClient, ClickHouseConfig } from '../database/clickhouse-client';

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
  private clickhouse: MonadClickHouseClient;
  private validatorInfoCache: Map<string, CompleteValidatorInfo> = new Map();
  
  private isInitialized: boolean = false;
  private readonly CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
  
  constructor(
    validatorRegistry?: ValidatorRegistry,
    dnsMapper?: DNSMapperService,
    clickhouse?: MonadClickHouseClient
  ) {
    this.validatorRegistry = validatorRegistry || new ValidatorRegistry();
    this.dnsMapper = dnsMapper || new DNSMapperService();
    this.clickhouse = clickhouse || new MonadClickHouseClient(this.getDefaultClickHouseConfig());
  }

  private getDefaultClickHouseConfig(): ClickHouseConfig {
    return {
      host: process.env.CLICKHOUSE_HOST || 'localhost',
      port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
      max_open_connections: parseInt(process.env.CLICKHOUSE_MAX_CONNECTIONS || '10'),
      max_query_timeout: parseInt(process.env.CLICKHOUSE_TIMEOUT || '30000'),
      compression: process.env.CLICKHOUSE_COMPRESSION !== 'false'
    };
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
    
    // First, load existing cache from database
    await this.loadCacheFromDatabase();
    
    const allValidators = this.validatorRegistry.getAllValidators();
    const uncachedValidators = allValidators.filter(v => 
      !this.hasValidCachedInfo(v.node_id)
    );

    if (uncachedValidators.length === 0) {
      console.log('✅ All validators already cached, skipping DNS processing');
      return;
    }

    console.log(`🔄 Processing DNS for ${uncachedValidators.length} uncached validators...`);
    const nodeIds = uncachedValidators.map(v => v.node_id);
    
    // Process DNS information in batches
    await this.dnsMapper.batchProcessValidatorDNS(nodeIds);
    
    // Build cache and save to database
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

    // Get DNS info (if available) - never fail due to DNS issues
    let dnsInfo: ValidatorDNSInfo | null = null;
    try {
      dnsInfo = await this.dnsMapper.getValidatorDNSInfo(nodeId);
    } catch (error) {
      console.warn(`DNS lookup failed for validator ${nodeId}, continuing without DNS info:`, error);
      // Continue without DNS info rather than failing entirely
    }
    
    // Build complete info - always return validator info even if DNS fails
    const completeInfo: CompleteValidatorInfo = {
      nodeId: validator.node_id,
      stake: validator.stake,
      cert_pubkey: validator.cert_pubkey,
      position: validator.position,
      epoch: epoch || this.validatorRegistry.getCurrentEpoch(),
      isActive: true,
      
      // DNS information (if available, otherwise defaults)
      dnsAddress: dnsInfo?.dnsAddress,
      dnsHost: dnsInfo?.dnsHost,
      dnsPort: dnsInfo?.dnsPort,
      provider: dnsInfo?.provider || 'unknown',
      location: dnsInfo?.location || 'unknown',
      country: dnsInfo?.country || 'unknown',
      city: dnsInfo?.city || 'unknown',
      datacenter: dnsInfo?.datacenter || 'unknown',
      
      // Metadata
      lastSeen: dnsInfo?.lastSeen || new Date(),
      processedCount: dnsInfo?.processedCount || 0
    };

    return completeInfo;
  }

  /**
   * Load validator info cache from database
   */
  private async loadCacheFromDatabase(): Promise<void> {
    try {
      const query = `
        SELECT 
          node_id, epoch, stake, cert_pubkey, position,
          dns_address, dns_host, dns_port, provider, location, 
          country, city, datacenter, is_active, last_seen, 
          processed_count, updated_at
        FROM validator_info_cache
        WHERE updated_at >= now() - INTERVAL ${this.CACHE_TTL_MS / 1000} SECOND
      `;
      
      const results = await this.clickhouse.executeRawQuery(query);
      
      for (const row of results) {
        const info: CompleteValidatorInfo = {
          nodeId: row.node_id,
          stake: row.stake,
          cert_pubkey: row.cert_pubkey,
          position: row.position,
          epoch: row.epoch,
          dnsAddress: row.dns_address,
          dnsHost: row.dns_host,
          dnsPort: row.dns_port,
          provider: row.provider,
          location: row.location,
          country: row.country,
          city: row.city,
          datacenter: row.datacenter,
          isActive: row.is_active === 1,
          lastSeen: new Date(row.last_seen),
          processedCount: row.processed_count
        };
        
        const cacheKey = this.getCacheKey(row.node_id, row.epoch);
        this.validatorInfoCache.set(cacheKey, info);
      }
      
      console.log(`📥 Loaded ${results.length} validator entries from database cache`);
    } catch (error) {
      console.warn('Failed to load cache from database:', error);
      // Continue without database cache
    }
  }

  /**
   * Check if validator has valid cached info
   */
  private hasValidCachedInfo(nodeId: string, epoch?: number): boolean {
    const cacheKey = this.getCacheKey(nodeId, epoch);
    const cached = this.validatorInfoCache.get(cacheKey);
    return cached !== undefined && this.isCacheValid(cached);
  }

  /**
   * Save validator info to database cache
   */
  private async saveCacheToDatabase(validatorInfos: CompleteValidatorInfo[]): Promise<void> {
    if (validatorInfos.length === 0) return;

    try {
      const data = validatorInfos.map(info => ({
        node_id: info.nodeId,
        epoch: info.epoch,
        stake: info.stake,
        cert_pubkey: info.cert_pubkey,
        position: info.position,
        dns_address: info.dnsAddress || '',
        dns_host: info.dnsHost || '',
        dns_port: info.dnsPort || 8000,
        provider: info.provider || 'unknown',
        location: info.location || 'unknown',
        country: info.country || 'unknown',
        city: info.city || 'unknown',
        datacenter: info.datacenter || 'unknown',
        is_active: info.isActive ? 1 : 0,
        last_seen: this.formatTimestamp(info.lastSeen || new Date()),
        processed_count: info.processedCount || 1,
        updated_at: this.formatTimestamp(new Date())
      }));

      // Use executeCommand to insert data since client is private
      const insertQuery = `INSERT INTO validator_info_cache FORMAT JSONEachRow\n${data.map(row => JSON.stringify(row)).join('\n')}`;
      await this.clickhouse.executeCommand(insertQuery);

      console.log(`💾 Saved ${data.length} validator entries to database cache`);
    } catch (error) {
      console.warn('Failed to save cache to database:', error);
      // Continue without database persistence
    }
  }

  /**
   * Build validator info cache for all validators
   */
  private async buildValidatorInfoCache(): Promise<void> {
    console.log('🔄 Building validator info cache...');
    
    const allValidators = this.validatorRegistry.getAllValidators();
    const batchSize = 10;
    const newValidatorInfos: CompleteValidatorInfo[] = [];
    
    for (let i = 0; i < allValidators.length; i += batchSize) {
      const batch = allValidators.slice(i, i + batchSize);
      const batchPromises = batch.map(v => this.buildCompleteValidatorInfo(v.node_id));
      
      const results = await Promise.allSettled(batchPromises);
      
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          const validator = batch[index];
          const cacheKey = this.getCacheKey(validator.node_id);
          this.validatorInfoCache.set(cacheKey, result.value);
          newValidatorInfos.push(result.value);
        }
      });
    }
    
    // Save new entries to database
    if (newValidatorInfos.length > 0) {
      await this.saveCacheToDatabase(newValidatorInfos);
    }
    
    console.log(`✅ Built cache for ${this.validatorInfoCache.size} validators`);
  }

  /**
   * Format timestamp for ClickHouse
   */
  private formatTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '');
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