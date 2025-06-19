import * as fs from 'fs';
import * as path from 'path';
import { IntelligentDNSParser } from '../utils/dns-parser';
import { DNSCacheManager } from '../utils/dns-cache';
import { NetworkDiscoveryService } from '../utils/network-discovery';
import { DNSParseResult } from '../utils/types';

export interface ValidatorDNSMapping {
  nodeId: string;
  dnsAddress: string;
  dnsHost: string;
  dnsPort: number;
}

export interface ValidatorDNSInfo {
  nodeId: string;
  dnsAddress: string;
  dnsHost: string;
  dnsPort: number;
  provider?: string;
  location?: string;
  country?: string;
  city?: string;
  datacenter?: string;
  lastUpdated: Date;
  lastSeen: Date;
  processedCount: number;
}

export interface DNSMapperStats {
  totalMappings: number;
  processedMappings: number;
  cachedMappings: number;
  errorCount: number;
  lastProcessed: Date | null;
  cacheHitRate: number;
}

/**
 * DNS Mapper Service - Single responsibility for DNS resolution and mapping
 * Uses node.toml for validator DNS mappings and existing DNS utilities for resolution
 */
export class DNSMapperService {
  private dnsParser: IntelligentDNSParser;
  private cacheManager: DNSCacheManager;
  private networkDiscovery: NetworkDiscoveryService;
  
  private validatorDNSMappings: Map<string, ValidatorDNSMapping> = new Map();
  private validatorDNSInfo: Map<string, ValidatorDNSInfo> = new Map();
  
  private isInitialized: boolean = false;
  private errorCount: number = 0;
  private lastProcessed: Date | null = null;
  
  // Cache settings
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly BATCH_DELAY_MS = 2000; // 2 seconds between batches
  
  constructor(private nodeTomlPath: string = 'validators/node.toml') {
    this.dnsParser = new IntelligentDNSParser();
    this.cacheManager = new DNSCacheManager({
      defaultTTL: this.CACHE_TTL_MS,
      maxCacheSize: 1000,
      enableAutoCleanup: true
    });
    this.networkDiscovery = new NetworkDiscoveryService();
  }

  /**
   * Initialize DNS mapper by loading node.toml and processing DNS mappings
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await this.loadNodeTomlMappings();
      console.log(`✅ DNS mapper initialized with ${this.validatorDNSMappings.size} validator DNS mappings`);
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize DNS mapper:', error);
      throw error;
    }
  }

  /**
   * Load DNS mappings from node.toml file
   */
  private async loadNodeTomlMappings(): Promise<void> {
    const filePath = path.resolve(this.nodeTomlPath);
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Node configuration file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    this.parseNodeTomlContent(content);
  }

  /**
   * Parse node.toml content to extract validator DNS mappings
   */
  private parseNodeTomlContent(content: string): void {
    const lines = content.split('\n');
    let currentAddress: string | null = null;
    let currentPubkey: string | null = null;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Parse address
      const addressMatch = trimmedLine.match(/^address = "(.+)"$/);
      if (addressMatch) {
        currentAddress = addressMatch[1];
        continue;
      }

      // Parse secp256k1_pubkey (completes mapping)
      const pubkeyMatch = trimmedLine.match(/^secp256k1_pubkey = "(.+)"$/);
      if (pubkeyMatch && currentAddress) {
        currentPubkey = pubkeyMatch[1];
        
        // Create mapping
        const nodeId = this.normalizeNodeId(currentPubkey);
        const [host, portStr] = currentAddress.split(':');
        const port = parseInt(portStr) || 8000;

        const mapping: ValidatorDNSMapping = {
          nodeId,
          dnsAddress: currentAddress,
          dnsHost: host,
          dnsPort: port
        };

        this.validatorDNSMappings.set(nodeId, mapping);
        
        // Reset for next entry
        currentAddress = null;
        currentPubkey = null;
      }
    }

    console.log(`Loaded ${this.validatorDNSMappings.size} DNS mappings from node.toml`);
  }

  /**
   * Get DNS mapping for a validator (basic mapping only)
   */
  getValidatorDNSMapping(nodeId: string): ValidatorDNSMapping | null {
    const normalizedId = this.normalizeNodeId(nodeId);
    return this.validatorDNSMappings.get(normalizedId) || null;
  }

  /**
   * Get enriched DNS information for a validator (with geolocation, provider, etc.)
   */
  async getValidatorDNSInfo(nodeId: string): Promise<ValidatorDNSInfo | null> {
    const normalizedId = this.normalizeNodeId(nodeId);
    
    // Check if we have cached info that's still valid
    const cached = this.validatorDNSInfo.get(normalizedId);
    if (cached && this.isCacheValid(cached)) {
      cached.lastSeen = new Date();
      cached.processedCount++;
      return cached;
    }

    // Get basic mapping
    const mapping = this.validatorDNSMappings.get(normalizedId);
    if (!mapping) {
      return null;
    }

    try {
      // Get enriched DNS information
      const dnsInfo = await this.enrichDNSMapping(mapping);
      
      // Cache the result
      this.validatorDNSInfo.set(normalizedId, dnsInfo);
      this.lastProcessed = new Date();
      
      return dnsInfo;
    } catch (error) {
      this.errorCount++;
      console.warn(`Failed to enrich DNS info for validator ${normalizedId}:`, error);
      
      // Return basic info if enrichment fails
      const basicInfo: ValidatorDNSInfo = {
        nodeId: normalizedId,
        dnsAddress: mapping.dnsAddress,
        dnsHost: mapping.dnsHost,
        dnsPort: mapping.dnsPort,
        provider: 'unknown',
        location: 'unknown',
        country: 'unknown',
        city: 'unknown',
        datacenter: 'unknown',
        lastUpdated: new Date(),
        lastSeen: new Date(),
        processedCount: 1
      };
      
      this.validatorDNSInfo.set(normalizedId, basicInfo);
      return basicInfo;
    }
  }

  /**
   * Enrich DNS mapping with geolocation and provider information
   */
  private async enrichDNSMapping(mapping: ValidatorDNSMapping): Promise<ValidatorDNSInfo> {
    let parseResult: DNSParseResult;
    
    // Check cache first
    const cached = this.cacheManager.get(mapping.dnsHost);
    if (cached) {
      parseResult = cached;
    } else {
      // Parse DNS with external services
      parseResult = await this.dnsParser.parse(mapping.dnsAddress);
      
      // Cache the result
      this.cacheManager.set(mapping.dnsHost, parseResult);
    }

    return {
      nodeId: mapping.nodeId,
      dnsAddress: mapping.dnsAddress,
      dnsHost: mapping.dnsHost,
      dnsPort: mapping.dnsPort,
      provider: parseResult.provider,
      location: `${parseResult.locationInfo.city}, ${parseResult.locationInfo.country}`,
      country: parseResult.locationInfo.country,
      city: parseResult.locationInfo.city,
      datacenter: parseResult.locationInfo.datacenter,
      lastUpdated: new Date(),
      lastSeen: new Date(),
      processedCount: 1
    };
  }

  /**
   * Batch process DNS information for multiple validators
   */
  async batchProcessValidatorDNS(nodeIds: string[]): Promise<ValidatorDNSInfo[]> {
    const results: ValidatorDNSInfo[] = [];
    const batchSize = 5; // Process in small batches to avoid rate limits

    console.log(`Processing DNS info for ${nodeIds.length} validators in batches of ${batchSize}`);

    for (let i = 0; i < nodeIds.length; i += batchSize) {
      const batch = nodeIds.slice(i, i + batchSize);
      const batchPromises = batch.map(nodeId => this.getValidatorDNSInfo(nodeId));

      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      });

      // Add delay between batches
      if (i + batchSize < nodeIds.length) {
        await this.delay(this.BATCH_DELAY_MS);
      }
    }

    return results;
  }

  /**
   * Pre-process all DNS mappings (for initialization)
   */
  async preProcessAllDNSMappings(): Promise<void> {
    const allNodeIds = Array.from(this.validatorDNSMappings.keys());
    console.log(`Pre-processing DNS information for all ${allNodeIds.length} validators...`);
    
    await this.batchProcessValidatorDNS(allNodeIds);
    
    console.log(`✅ Pre-processed DNS information for ${this.validatorDNSInfo.size} validators`);
  }

  /**
   * Get all DNS mappings (basic)
   */
  getAllDNSMappings(): ValidatorDNSMapping[] {
    return Array.from(this.validatorDNSMappings.values());
  }

  /**
   * Get all processed DNS information
   */
  getAllDNSInfo(): ValidatorDNSInfo[] {
    return Array.from(this.validatorDNSInfo.values());
  }

  /**
   * Check if validator has DNS mapping
   */
  hasValidatorDNS(nodeId: string): boolean {
    const normalizedId = this.normalizeNodeId(nodeId);
    return this.validatorDNSMappings.has(normalizedId);
  }

  /**
   * Get DNS mapper statistics
   */
  getStats(): DNSMapperStats {
    const totalMappings = this.validatorDNSMappings.size;
    const processedMappings = this.validatorDNSInfo.size;
    const cachedMappings = this.cacheManager.getStats().hitRate || 0;

    return {
      totalMappings,
      processedMappings,
      cachedMappings,
      errorCount: this.errorCount,
      lastProcessed: this.lastProcessed,
      cacheHitRate: totalMappings > 0 ? (processedMappings / totalMappings) * 100 : 0
    };
  }

  /**
   * Force refresh DNS info for a validator
   */
  async forceRefreshValidator(nodeId: string): Promise<ValidatorDNSInfo | null> {
    const normalizedId = this.normalizeNodeId(nodeId);
    
    // Remove from cache
    this.validatorDNSInfo.delete(normalizedId);
    const mapping = this.validatorDNSMappings.get(normalizedId);
    if (mapping) {
      this.cacheManager.delete(mapping.dnsHost);
    }
    
    return await this.getValidatorDNSInfo(normalizedId);
  }

  /**
   * Clean up expired cache entries
   */
  cleanupExpiredCache(): void {
    const now = new Date();
    for (const [nodeId, info] of this.validatorDNSInfo.entries()) {
      if (now.getTime() - info.lastSeen.getTime() > this.CACHE_TTL_MS) {
        this.validatorDNSInfo.delete(nodeId);
      }
    }
    
    // Also cleanup DNS cache
    this.cacheManager.cleanup();
  }

  /**
   * Reload DNS mappings from node.toml
   */
  async reload(): Promise<void> {
    this.isInitialized = false;
    this.validatorDNSMappings.clear();
    this.validatorDNSInfo.clear();
    this.errorCount = 0;
    this.lastProcessed = null;
    await this.initialize();
  }

  /**
   * Check if cached DNS info is still valid
   */
  private isCacheValid(info: ValidatorDNSInfo): boolean {
    const now = new Date();
    return now.getTime() - info.lastSeen.getTime() < this.CACHE_TTL_MS;
  }

  /**
   * Normalize node ID by removing 0x prefix if present
   */
  private normalizeNodeId(nodeId: string): string {
    return nodeId.startsWith('0x') ? nodeId.slice(2) : nodeId;
  }

  /**
   * Utility delay function
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const dnsMapper = new DNSMapperService(); 