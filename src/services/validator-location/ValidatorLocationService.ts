import { IValidatorLocationService } from './interfaces/IValidatorLocationService';
import { ILocationMapper } from './interfaces/ILocationMapper';
import { IDnsService } from '../dns/interfaces/IDnsService';
import { IGeolocationService } from '../geolocation/interfaces/IGeolocationService';
import {
  ValidatorLocation,
  ValidatorLocationStats,
  LocationProcessResult,
  ValidatorLocationServiceConfig,
  ValidatorMapping
} from './types';
import { DnsService } from '../dns/DnsService';
import { GeolocationService } from '../geolocation/GeolocationService';
import { DomainExtractor } from '../dns/DomainExtractor';

export class ValidatorLocationService implements IValidatorLocationService {
  private readonly locationMapper: ILocationMapper;
  private readonly dnsService: IDnsService;
  private readonly geolocationService: IGeolocationService;
  private readonly domainExtractor: DomainExtractor;
  private readonly config: ValidatorLocationServiceConfig;
  
  private validatorLocations: Map<string, ValidatorLocation> = new Map();
  private isInitialized = false;
  
  // Statistics tracking
  private totalProcessed = 0;
  private dnsSuccesses = 0;
  private geolocationSuccesses = 0;
  private totalProcessingTime = 0;
  
  constructor(
    locationMapper: ILocationMapper,
    dnsService?: IDnsService,
    geolocationService?: IGeolocationService,
    config?: Partial<ValidatorLocationServiceConfig>
  ) {
    this.config = {
      tomlFilePath: 'validators/node.toml', // Kept for backward compatibility but not used
      enableCaching: true,
      batchSize: 50,
      processingDelay: 1500,
      retryFailedLookups: true,
      maxRetries: 2,
      ...config
    };

    if (!locationMapper) {
      throw new Error('locationMapper is required - must provide IpcLocationMapper');
    }

    this.locationMapper = locationMapper;
    this.dnsService = dnsService || new DnsService();
    this.geolocationService = geolocationService || new GeolocationService();
    this.domainExtractor = new DomainExtractor();
  }
  
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    console.log('🔧 Initializing Validator Location Service...');

    try {
      // Load validator mappings from IPC
      await this.locationMapper.loadMappings();

      console.log('✅ Validator Location Service initialized successfully');
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize Validator Location Service:', error);
      throw error;
    }
  }
  
  async getValidatorLocation(nodeId: string): Promise<ValidatorLocation | null> {
    const normalizedId = this.normalizeNodeId(nodeId);
    
    // Check cache first
    if (this.config.enableCaching) {
      const cached = this.validatorLocations.get(normalizedId);
      if (cached) {
        return cached;
      }
    }
    
    // Get mapping
    const mapping = this.locationMapper.getMapping(normalizedId);
    if (!mapping) {
      return null;
    }
    
    // Process location
    const result = await this.processValidatorLocation(mapping);
    
    // Cache result if successful
    if (result.success && this.config.enableCaching) {
      this.validatorLocations.set(normalizedId, result.validator);
    }
    
    return result.success ? result.validator : null;
  }
  
  async getValidatorLocations(nodeIds: string[]): Promise<Map<string, ValidatorLocation>> {
    const results = new Map<string, ValidatorLocation>();
    const batchSize = this.config.batchSize;
    
    for (let i = 0; i < nodeIds.length; i += batchSize) {
      const batch = nodeIds.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (nodeId) => {
        const location = await this.getValidatorLocation(nodeId);
        return { nodeId, location };
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.location) {
          results.set(this.normalizeNodeId(result.value.nodeId), result.value.location);
        }
      });
      
      // Add delay between batches
      if (i + batchSize < nodeIds.length) {
        await this.delay(this.config.processingDelay);
      }
    }
    
    return results;
  }
  
  async getAllValidatorLocations(): Promise<ValidatorLocation[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const mappings = this.locationMapper.getAllMappings();
    const nodeIds = mappings.map(m => m.nodeId);
    
    const locations = await this.getValidatorLocations(nodeIds);
    return Array.from(locations.values());
  }
  
  async processAllValidatorLocations(): Promise<LocationProcessResult[]> {
    console.log('🔄 Processing all validator locations...');
    
    const mappings = this.locationMapper.getAllMappings();
    console.log(`📋 Processing ${mappings.length} validators with batch geolocation API`);
    
    return await this.processValidatorLocationsBatch(mappings);
  }

  /**
   * Process validator locations using batch API to avoid rate limits
   */
  async processValidatorLocationsBatch(mappings: ValidatorMapping[]): Promise<LocationProcessResult[]> {
    const startTime = Date.now();
    const results: LocationProcessResult[] = [];
    
    // Step 1: Resolve hostnames to IPs (skip if already IP)
    console.log('🌐 Step 1: Resolving hostnames to IPs...');
    console.log(`📝 Total validators to process: ${mappings.length}`);
    
    const hostnameToIpMap = new Map<string, string>();
    const needsResolution: string[] = [];
    
    // Separate IPs from hostnames
    for (const mapping of mappings) {
      if (this.isValidIp(mapping.hostname)) {
        // Already an IP address, no DNS resolution needed
        hostnameToIpMap.set(mapping.hostname, mapping.hostname);
        this.dnsSuccesses++;
      } else {
        // Actual hostname, needs DNS resolution
        needsResolution.push(mapping.hostname);
      }
    }
    
    console.log(`   ✓ ${hostnameToIpMap.size} are already IP addresses`);
    console.log(`   📡 ${needsResolution.length} hostnames need DNS resolution`);
    
    // Resolve actual hostnames
    if (needsResolution.length > 0) {
      const resolvedMap = await this.dnsService.resolveHostnames(needsResolution);
      
      resolvedMap.forEach((ip, hostname) => {
        hostnameToIpMap.set(hostname, ip);
        this.dnsSuccesses++;
      });
    }
    
    this.totalProcessed += mappings.length;
    
    console.log(`✅ DNS resolution complete: ${hostnameToIpMap.size}/${mappings.length} successful`);
    
    // Step 2: Batch geolocate all unique IPs using batch API
    const uniqueIps = [...new Set(hostnameToIpMap.values())];
    console.log(`🌍 Step 2: Batch geolocating ${uniqueIps.length} unique IPs...`);
    
    let ipToGeoMap = new Map<string, any>();
    
    try {
      // Use batch geolocation if available
      if ('getLocationsBatch' in this.geolocationService) {
        console.log('📡 Using ip-api.com batch API...');
        ipToGeoMap = await (this.geolocationService as any).getLocationsBatch(uniqueIps);
        console.log(`✅ Batch geolocation complete: ${ipToGeoMap.size}/${uniqueIps.length} successful`);
      } else {
        console.log('⚠️ Batch API not available, using individual requests...');
        // Fallback to individual requests with delays
        for (const ip of uniqueIps) {
          try {
            const geoData = await this.geolocationService.getLocationForIp(ip);
            if (geoData) {
              ipToGeoMap.set(ip, geoData);
              this.geolocationSuccesses++;
            }
            // Add delay to avoid rate limits
            await this.delay(200);
          } catch (error) {
            console.warn(`Geolocation failed for ${ip}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('❌ Batch geolocation failed:', error);
    }
    
    // Step 3: Combine results for each validator
    console.log('🔧 Step 3: Combining results for each validator...');
    
    for (const mapping of mappings) {
      const processingStartTime = Date.now();
      
      try {
        const validatorLocation = this.createBasicValidatorLocation(mapping);
        
        // Get IP for this hostname
        const ip = hostnameToIpMap.get(mapping.hostname);
        if (ip) {
          validatorLocation.ip = ip;
          
          // Get geolocation data for this IP
          const geoData = ipToGeoMap.get(ip);
          if (geoData) {
            validatorLocation.country = geoData.country;
            validatorLocation.region = geoData.region;
            validatorLocation.city = geoData.city;
            validatorLocation.latitude = geoData.latitude;
            validatorLocation.longitude = geoData.longitude;
            validatorLocation.isp = geoData.isp;
            validatorLocation.organization = geoData.organization;
            validatorLocation.timezone = geoData.timezone;
            validatorLocation.countryCode = geoData.countryCode;
            validatorLocation.regionCode = geoData.regionCode;
            validatorLocation.resolvedAt = new Date();
          }
        }
        
        const processingTime = Date.now() - processingStartTime;
        this.totalProcessingTime += processingTime;
        validatorLocation.lastUpdated = new Date();
        
        const result: LocationProcessResult = {
          success: true,
          validator: validatorLocation,
          processingTime
        };
        
        results.push(result);
        
        // Cache successful results
        if (this.config.enableCaching) {
          this.validatorLocations.set(validatorLocation.nodeId, validatorLocation);
        }
        
      } catch (error) {
        const processingTime = Date.now() - processingStartTime;
        this.totalProcessingTime += processingTime;
        
        results.push({
          success: false,
          validator: this.createBasicValidatorLocation(mapping),
          error: error instanceof Error ? error.message : 'Unknown error',
          processingTime
        });
      }
    }
    
    const totalTime = Date.now() - startTime;
    const successful = results.filter(r => r.success).length;
    
    console.log(`✅ Batch processing complete: ${successful}/${results.length} successful in ${totalTime}ms`);
    
    return results;
  }
  
  async refreshValidatorLocation(nodeId: string): Promise<ValidatorLocation | null> {
    const normalizedId = this.normalizeNodeId(nodeId);

    // Remove from cache to force refresh
    this.validatorLocations.delete(normalizedId);

    // Get fresh location data
    return await this.getValidatorLocation(normalizedId);
  }

  /**
   * Refresh location data for multiple validators (used during IPC polling)
   * Returns updated ValidatorLocation objects
   */
  async refreshValidatorLocations(nodeIds: string[]): Promise<LocationProcessResult[]> {
    console.log(`🔄 Refreshing location data for ${nodeIds.length} validators...`);

    // Get current mappings for these validators
    const mappings: ValidatorMapping[] = [];
    for (const nodeId of nodeIds) {
      const mapping = this.locationMapper.getMapping(nodeId);
      if (mapping) {
        // Clear from cache to force refresh
        this.validatorLocations.delete(this.normalizeNodeId(nodeId));
        mappings.push(mapping);
      }
    }

    if (mappings.length === 0) {
      console.log('⚠️ No mappings found for provided nodeIds');
      return [];
    }

    // Process locations using batch API
    const results = await this.processValidatorLocationsBatch(mappings);

    console.log(`✅ Refreshed ${results.filter(r => r.success).length}/${results.length} validator locations`);

    return results;
  }

  getStats(): ValidatorLocationStats {
    const totalValidators = this.locationMapper.getAllMappings().length;
    const validatorsWithLocation = this.validatorLocations.size;
    const dnsStats = this.dnsService.getStats();
    const geoStats = this.geolocationService.getStats();
    
    return {
      totalValidators,
      validatorsWithLocation,
      validatorsWithoutLocation: totalValidators - validatorsWithLocation,
      locationCoverage: totalValidators > 0 ? (validatorsWithLocation / totalValidators) * 100 : 0,
      dnsResolutionSuccessRate: this.totalProcessed > 0 ? (this.dnsSuccesses / this.totalProcessed) * 100 : 0,
      geolocationSuccessRate: this.totalProcessed > 0 ? (this.geolocationSuccesses / this.totalProcessed) * 100 : 0,
      avgProcessingTime: this.totalProcessed > 0 ? this.totalProcessingTime / this.totalProcessed : 0,
      cacheHitRate: dnsStats.hitRate // Use DNS cache hit rate as proxy
    };
  }
  
  hasValidatorLocation(nodeId: string): boolean {
    const normalizedId = this.normalizeNodeId(nodeId);
    return this.validatorLocations.has(normalizedId);
  }
  
  clearCache(): void {
    this.validatorLocations.clear();
    this.dnsService.clearCache();
    this.geolocationService.clearCache();
  }
  
  private async processValidatorLocation(mapping: ValidatorMapping): Promise<LocationProcessResult> {
    const startTime = Date.now();
    
    try {
      // Start with basic location
      const validatorLocation = this.createBasicValidatorLocation(mapping);
      
      // Step 1: DNS resolution
      const ip = await this.dnsService.resolveHostname(mapping.hostname);
      
      if (ip) {
        this.dnsSuccesses++;
        validatorLocation.ip = ip;
        
        // Step 2: Geolocation
        const geoData = await this.geolocationService.getLocationForIp(ip);
        
        if (geoData) {
          this.geolocationSuccesses++;
          validatorLocation.country = geoData.country;
          validatorLocation.region = geoData.region;
          validatorLocation.city = geoData.city;
          validatorLocation.latitude = geoData.latitude;
          validatorLocation.longitude = geoData.longitude;
          validatorLocation.isp = geoData.isp;
          validatorLocation.organization = geoData.organization;
          validatorLocation.timezone = geoData.timezone;
          validatorLocation.countryCode = geoData.countryCode;
          validatorLocation.regionCode = geoData.regionCode;
          validatorLocation.resolvedAt = new Date();
        }
      }
      
      const processingTime = Date.now() - startTime;
      this.totalProcessed++;
      this.totalProcessingTime += processingTime;
      
      validatorLocation.lastUpdated = new Date();
      
      return {
        success: true,
        validator: validatorLocation,
        processingTime
      };
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.totalProcessed++;
      this.totalProcessingTime += processingTime;
      
      return {
        success: false,
        validator: this.createBasicValidatorLocation(mapping),
        error: error instanceof Error ? error.message : 'Unknown error',
        processingTime
      };
    }
  }
  
  private createBasicValidatorLocation(mapping: ValidatorMapping): ValidatorLocation {
    // Extract validator name from hostname
    const validatorName = this.domainExtractor.extractValidatorName(mapping.hostname);
    
    return {
      nodeId: mapping.nodeId,
      dnsAddress: mapping.dnsAddress,
      hostname: mapping.hostname,
      port: mapping.port,
      validatorName,
      lastUpdated: new Date()
    };
  }
  
  private normalizeNodeId(nodeId: string): string {
    return nodeId.startsWith('0x') ? nodeId.slice(2).toLowerCase() : nodeId.toLowerCase();
  }
  
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get validators by location
   */
  getValidatorsByCountry(country: string): ValidatorLocation[] {
    return Array.from(this.validatorLocations.values())
      .filter(v => v.country?.toLowerCase() === country.toLowerCase());
  }
  
  /**
   * Get validators by city
   */
  getValidatorsByCity(city: string): ValidatorLocation[] {
    return Array.from(this.validatorLocations.values())
      .filter(v => v.city?.toLowerCase() === city.toLowerCase());
  }
  
  /**
   * Get validators by ISP
   */
  getValidatorsByIsp(isp: string): ValidatorLocation[] {
    return Array.from(this.validatorLocations.values())
      .filter(v => v.isp?.toLowerCase().includes(isp.toLowerCase()));
  }
  
  /**
   * Get geographic distribution
   */
  getGeographicDistribution(): Map<string, number> {
    const distribution = new Map<string, number>();
    
    this.validatorLocations.forEach(validator => {
      if (validator.country && validator.city) {
        const location = `${validator.city}, ${validator.country}`;
        distribution.set(location, (distribution.get(location) || 0) + 1);
      }
    });
    
    return distribution;
  }
  
  /**
   * Get ISP distribution
   */
  getIspDistribution(): Map<string, number> {
    const distribution = new Map<string, number>();
    
    this.validatorLocations.forEach(validator => {
      if (validator.isp) {
        distribution.set(validator.isp, (distribution.get(validator.isp) || 0) + 1);
      }
    });
    
    return distribution;
  }
  
  /**
   * Check if a string is a valid IP address (IPv4 or IPv6)
   */
  private isValidIp(address: string): boolean {
    // IPv4 pattern
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    
    // IPv6 pattern (simplified)
    const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    
    if (ipv4Pattern.test(address)) {
      // Validate IPv4 octets are in range 0-255
      const octets = address.split('.');
      return octets.every(octet => {
        const num = parseInt(octet, 10);
        return num >= 0 && num <= 255;
      });
    }
    
    return ipv6Pattern.test(address);
  }
} 