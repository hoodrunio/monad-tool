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
   * Pre-process all validator DNS information
   * Enhanced to avoid unnecessary DNS processing when data is cached in database
   */
  async preProcessAll(): Promise<void> {
    console.log('🔄 Pre-processing all validator DNS information...');
    
    // First, load existing cache from database
    const loadStartTime = Date.now();
    await this.loadCacheFromDatabase();
    console.log(`📥 Cache loading completed in ${Date.now() - loadStartTime}ms`);
    
    const allValidators = this.validatorRegistry.getAllValidators();
    console.log(`📋 Total validators to check: ${allValidators.length}`);
    
    // Check for validators that need DNS processing
    const uncachedValidators = allValidators.filter(v => 
      !this.hasValidCachedInfo(v.node_id)
    );
    
    console.log(`📊 Cache analysis: ${this.validatorInfoCache.size} cached, ${uncachedValidators.length} need processing`);

    if (uncachedValidators.length === 0) {
      console.log('✅ All validators already cached in database, skipping DNS processing');
      // Even if all are cached, check for partial data that needs retry
      await this.retryPartialGeolocationData();
      return;
    }

    console.log(`🔄 Processing DNS for ${uncachedValidators.length} uncached validators...`);
    const nodeIds = uncachedValidators.map(v => v.node_id);
    
    // Process DNS information in batches only for uncached validators
    const dnsStartTime = Date.now();
    await this.dnsMapper.batchProcessValidatorDNS(nodeIds);
    console.log(`🌐 DNS processing completed in ${Date.now() - dnsStartTime}ms`);
    
    // Build cache and save to database only for newly processed validators
    const cacheStartTime = Date.now();
    await this.buildValidatorInfoCacheForValidators(nodeIds);
    console.log(`💾 Cache building completed in ${Date.now() - cacheStartTime}ms`);
    
    // Check for partial geolocation data and retry
    await this.retryPartialGeolocationData();
    
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
   * Enhanced to also populate DNS mapper cache to avoid redundant processing
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
        WHERE updated_at >= now() - INTERVAL ${Math.floor(this.CACHE_TTL_MS / 1000)} SECOND
      `;
      
      const results = await this.clickhouse.executeRawQuery(query);
      let populatedDnsMapperCount = 0;
      
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
        
        // Also populate DNS mapper cache if we have DNS info
        if (info.dnsHost && info.dnsAddress && info.provider && info.provider !== 'unknown') {
          try {
            const dnsInfo = {
              nodeId: info.nodeId,
              dnsAddress: info.dnsAddress,
              dnsHost: info.dnsHost,
              dnsPort: info.dnsPort || 8000,
              provider: info.provider,
              location: info.location || 'unknown',
              country: info.country || 'unknown',
              city: info.city || 'unknown',
              datacenter: info.datacenter || 'unknown',
              lastUpdated: new Date(row.updated_at),
              lastSeen: info.lastSeen,
              processedCount: info.processedCount || 1
            };
            
            // Populate DNS mapper's internal cache to avoid reprocessing
            // This is a bit of a hack, but necessary to prevent redundant DNS processing
            (this.dnsMapper as any).validatorDNSInfo?.set(info.nodeId, dnsInfo);
            populatedDnsMapperCount++;
          } catch (error) {
            console.warn(`Failed to populate DNS mapper cache for ${row.node_id}:`, error);
          }
        }
      }
      
      console.log(`📥 Loaded ${results.length} validator entries from database cache`);
      if (populatedDnsMapperCount > 0) {
        console.log(`🔄 Populated DNS mapper cache with ${populatedDnsMapperCount} entries to avoid reprocessing`);
      }
    } catch (error) {
      console.warn('Failed to load cache from database:', error);
      // Continue without database cache
    }
  }

  /**
   * Check if cached validator info is still valid
   * Enhanced to be more lenient with database-cached data
   */
  private isCacheValid(info: CompleteValidatorInfo): boolean {
    if (!info.lastSeen) {
      // If no lastSeen timestamp, consider valid for basic validator info
      return info.nodeId !== undefined && info.stake !== undefined;
    }
    
    const now = new Date();
    const ageMs = now.getTime() - info.lastSeen.getTime();
    
    // Be more lenient for database-cached data
    // Only consider invalid if very old (7 days) or missing critical DNS info
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days instead of 12 hours
    
    // If data is newer than 7 days, it's valid
    if (ageMs < maxAgeMs) {
      return true;
    }
    
    // If data is older than 7 days but has DNS info, still consider valid
    // (DNS info doesn't change frequently)
    if (info.dnsAddress && info.provider && info.provider !== 'unknown') {
      return true;
    }
    
    // Only consider invalid if very old AND missing DNS info
    return false;
  }

  /**
   * Check if validator has valid cached info
   * Enhanced with better logging for debugging
   */
  private hasValidCachedInfo(nodeId: string, epoch?: number): boolean {
    const cacheKey = this.getCacheKey(nodeId, epoch);
    const cached = this.validatorInfoCache.get(cacheKey);
    
    if (!cached) {
      return false;
    }
    
    const isValid = this.isCacheValid(cached);
    
    // Debug logging to understand cache behavior
    if (!isValid) {
      const ageHours = cached.lastSeen ? 
        Math.round((Date.now() - cached.lastSeen.getTime()) / (1000 * 60 * 60)) : 
        'unknown';
      console.log(`🔍 Cache invalid for ${nodeId.substring(0, 8)}: age=${ageHours}h, dns=${cached.dnsAddress ? 'yes' : 'no'}, provider=${cached.provider}`);
    }
    
    return isValid;
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
   * Build validator info cache for specific validators (optimization for partial cache updates)
   */
  private async buildValidatorInfoCacheForValidators(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    
    console.log(`🔄 Building validator info cache for ${nodeIds.length} specific validators...`);
    
    const batchSize = 10;
    const newValidatorInfos: CompleteValidatorInfo[] = [];
    
    for (let i = 0; i < nodeIds.length; i += batchSize) {
      const batch = nodeIds.slice(i, i + batchSize);
      const batchPromises = batch.map(nodeId => this.buildCompleteValidatorInfo(nodeId));
      
      const results = await Promise.allSettled(batchPromises);
      
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          const nodeId = batch[index];
          const cacheKey = this.getCacheKey(nodeId);
          this.validatorInfoCache.set(cacheKey, result.value);
          newValidatorInfos.push(result.value);
        }
      });
    }
    
    // Save new entries to database
    if (newValidatorInfos.length > 0) {
      await this.saveCacheToDatabase(newValidatorInfos);
    }
    
    console.log(`✅ Built cache for ${newValidatorInfos.length}/${nodeIds.length} specific validators`);
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

  /**
   * Retry DNS resolution for validators with partial geolocation data
   * (region/country != unknown but datacenter == unknown)
   */
  async retryPartialGeolocationData(): Promise<void> {
    console.log('🔄 Checking for validators with partial geolocation data...');
    
    const validatorsToRetry: string[] = [];
    
    // Check all cached validator info for partial data
    for (const [cacheKey, info] of this.validatorInfoCache.entries()) {
      if (this.hasPartialGeolocationData(info)) {
        validatorsToRetry.push(info.nodeId);
      }
    }
    
    // Also check validators from DNS mapper that might not be in our cache
    const allDNSInfo = this.dnsMapper.getAllDNSInfo();
    for (const dnsInfo of allDNSInfo) {
      if (this.hasPartialGeolocationDataFromDNS(dnsInfo)) {
        const normalizedId = this.normalizeNodeId(dnsInfo.nodeId);
        if (!validatorsToRetry.includes(normalizedId)) {
          validatorsToRetry.push(normalizedId);
        }
      }
    }
    
    if (validatorsToRetry.length === 0) {
      console.log('✅ No validators found with partial geolocation data');
      return;
    }
    
    console.log(`🔄 Found ${validatorsToRetry.length} validators with partial geolocation data, retrying DNS resolution...`);
    
    // Force refresh DNS info for validators with partial data
    let successCount = 0;
    let improvedCount = 0;
    
    for (const nodeId of validatorsToRetry) {
      try {
        console.log(`🔄 Retrying DNS resolution for validator ${nodeId}`);
        
        // Get current state before retry
        const beforeInfo = this.getValidatorInfoSync(nodeId);
        const beforeDatacenter = beforeInfo?.datacenter || 'unknown';
        
        // Force refresh DNS info
        const refreshedInfo = await this.refreshValidator(nodeId);
        
        if (refreshedInfo) {
          successCount++;
          
          // Check if datacenter info was improved
          if (beforeDatacenter === 'unknown' && refreshedInfo.datacenter !== 'unknown') {
            improvedCount++;
            console.log(`✅ Improved datacenter info for ${nodeId.substring(0, 8)}: ${refreshedInfo.datacenter}`);
          }
        }
        
        // Add small delay to avoid overwhelming external APIs
        await this.delay(1000);
        
      } catch (error) {
        console.warn(`⚠️ Failed to retry DNS for validator ${nodeId.substring(0, 8)}:`, error);
        // Continue with other validators
      }
    }
    
    console.log(`✅ Partial geolocation retry completed: ${successCount}/${validatorsToRetry.length} successful, ${improvedCount} improved`);
    
    // Update cache to database after improvements
    if (improvedCount > 0) {
      await this.buildValidatorInfoCache();
    }
  }

  /**
   * Check if validator has partial geolocation data
   * Returns true if region/country is known but datacenter is unknown
   */
  private hasPartialGeolocationData(info: CompleteValidatorInfo): boolean {
    const hasKnownRegion = Boolean(info.country && info.country !== 'unknown');
    const hasUnknownDatacenter = Boolean(!info.datacenter || info.datacenter === 'unknown');
    
    return hasKnownRegion && hasUnknownDatacenter;
  }

  /**
   * Check if DNS info has partial geolocation data
   */
  private hasPartialGeolocationDataFromDNS(dnsInfo: ValidatorDNSInfo): boolean {
    const hasKnownRegion = Boolean(dnsInfo.country && dnsInfo.country !== 'unknown');
    const hasUnknownDatacenter = Boolean(!dnsInfo.datacenter || dnsInfo.datacenter === 'unknown');
    
    return hasKnownRegion && hasUnknownDatacenter;
  }

  /**
   * Utility delay function
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Manually trigger retry of partial geolocation data
   * Public method that can be called from scripts or other services
   */
  async retryPartialValidators(): Promise<{ found: number; improved: number; successful: number }> {
    console.log('🔄 Manual retry of validators with partial geolocation data requested...');
    
    const validatorsToRetry: string[] = [];
    
    // Check all cached validator info for partial data
    for (const [cacheKey, info] of this.validatorInfoCache.entries()) {
      if (this.hasPartialGeolocationData(info)) {
        validatorsToRetry.push(info.nodeId);
      }
    }
    
    // Also check validators from DNS mapper that might not be in our cache
    const allDNSInfo = this.dnsMapper.getAllDNSInfo();
    for (const dnsInfo of allDNSInfo) {
      if (this.hasPartialGeolocationDataFromDNS(dnsInfo)) {
        const normalizedId = this.normalizeNodeId(dnsInfo.nodeId);
        if (!validatorsToRetry.includes(normalizedId)) {
          validatorsToRetry.push(normalizedId);
        }
      }
    }
    
    if (validatorsToRetry.length === 0) {
      console.log('✅ No validators found with partial geolocation data');
      return { found: 0, improved: 0, successful: 0 };
    }
    
    console.log(`🔄 Found ${validatorsToRetry.length} validators with partial geolocation data, retrying DNS resolution...`);
    
    // Force refresh DNS info for validators with partial data
    let successCount = 0;
    let improvedCount = 0;
    
    for (const nodeId of validatorsToRetry) {
      try {
        console.log(`🔄 Retrying DNS resolution for validator ${nodeId}`);
        
        // Get current state before retry
        const beforeInfo = this.getValidatorInfoSync(nodeId);
        const beforeDatacenter = beforeInfo?.datacenter || 'unknown';
        
        // Force refresh DNS info
        const refreshedInfo = await this.refreshValidator(nodeId);
        
        if (refreshedInfo) {
          successCount++;
          
          // Check if datacenter info was improved
          if (beforeDatacenter === 'unknown' && refreshedInfo.datacenter !== 'unknown') {
            improvedCount++;
            console.log(`✅ Improved datacenter info for ${nodeId.substring(0, 8)}: ${refreshedInfo.datacenter}`);
          }
        }
        
        // Add small delay to avoid overwhelming external APIs
        await this.delay(1000);
        
      } catch (error) {
        console.warn(`⚠️ Failed to retry DNS for validator ${nodeId.substring(0, 8)}:`, error);
        // Continue with other validators
      }
    }
    
    console.log(`✅ Manual partial geolocation retry completed: ${successCount}/${validatorsToRetry.length} successful, ${improvedCount} improved`);
    
    // Update cache to database after improvements
    if (improvedCount > 0) {
      await this.buildValidatorInfoCache();
    }
    
    return { 
      found: validatorsToRetry.length, 
      improved: improvedCount, 
      successful: successCount 
    };
  }

  /**
   * Get detailed cache status for debugging
   */
  getCacheStatus(): {
    totalCached: number;
    validEntries: number;
    expiredEntries: number;
    entriesWithDns: number;
    entriesWithoutDns: number;
    avgAge: number;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  } {
    let validEntries = 0;
    let expiredEntries = 0;
    let entriesWithDns = 0;
    let entriesWithoutDns = 0;
    let totalAge = 0;
    let oldestEntry: Date | null = null;
    let newestEntry: Date | null = null;

    for (const [key, info] of this.validatorInfoCache.entries()) {
      if (this.isCacheValid(info)) {
        validEntries++;
      } else {
        expiredEntries++;
      }

      if (info.dnsAddress && info.provider && info.provider !== 'unknown') {
        entriesWithDns++;
      } else {
        entriesWithoutDns++;
      }

      if (info.lastSeen) {
        const entryAge = Date.now() - info.lastSeen.getTime();
        totalAge += entryAge;

        if (!oldestEntry || info.lastSeen < oldestEntry) {
          oldestEntry = info.lastSeen;
        }

        if (!newestEntry || info.lastSeen > newestEntry) {
          newestEntry = info.lastSeen;
        }
      }
    }

    const avgAge = this.validatorInfoCache.size > 0 ? totalAge / this.validatorInfoCache.size : 0;

    return {
      totalCached: this.validatorInfoCache.size,
      validEntries,
      expiredEntries,
      entriesWithDns,
      entriesWithoutDns,
      avgAge: Math.round(avgAge / (1000 * 60 * 60)), // in hours
      oldestEntry,
      newestEntry
    };
  }

  /**
   * Force reload cache from database (useful for debugging)
   */
  async forceReloadFromDatabase(): Promise<void> {
    console.log('🔄 Force reloading cache from database...');
    
    // Clear current cache
    this.validatorInfoCache.clear();
    
    // Reload from database
    await this.loadCacheFromDatabase();
    
    const status = this.getCacheStatus();
    console.log(`✅ Force reload completed: ${status.totalCached} entries loaded, ${status.validEntries} valid, ${status.entriesWithDns} with DNS`);
  }

  /**
   * Check if system should skip DNS processing (for startup optimization)
   */
  shouldSkipDnsProcessing(): boolean {
    const status = this.getCacheStatus();
    const totalValidators = this.validatorRegistry.getAllValidators().length;
    
    // Skip if we have valid cache for at least 80% of validators
    const cacheCoverage = totalValidators > 0 ? (status.validEntries / totalValidators) * 100 : 0;
    const shouldSkip = cacheCoverage >= 80;
    
    console.log(`📊 DNS processing decision: ${cacheCoverage.toFixed(1)}% cache coverage, ${shouldSkip ? 'SKIPPING' : 'PROCESSING'} DNS`);
    
    return shouldSkip;
  }
}

// Singleton instance
export const validatorInfoService = new ValidatorInfoService(); 