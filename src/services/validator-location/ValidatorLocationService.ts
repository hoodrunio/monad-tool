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
import { TomlLocationMapper } from './mappers/TomlLocationMapper';
import { DnsService } from '../dns/DnsService';
import { GeolocationService } from '../geolocation/GeolocationService';

export class ValidatorLocationService implements IValidatorLocationService {
  private readonly locationMapper: ILocationMapper;
  private readonly dnsService: IDnsService;
  private readonly geolocationService: IGeolocationService;
  private readonly config: ValidatorLocationServiceConfig;
  
  private validatorLocations: Map<string, ValidatorLocation> = new Map();
  private isInitialized = false;
  
  // Statistics tracking
  private totalProcessed = 0;
  private dnsSuccesses = 0;
  private geolocationSuccesses = 0;
  private totalProcessingTime = 0;
  
  constructor(
    locationMapper?: ILocationMapper,
    dnsService?: IDnsService,
    geolocationService?: IGeolocationService,
    config?: Partial<ValidatorLocationServiceConfig>
  ) {
    this.config = {
      tomlFilePath: 'validators/node.toml',
      enableCaching: true,
      batchSize: 5,
      processingDelay: 1500,
      retryFailedLookups: true,
      maxRetries: 2,
      ...config
    };
    
    this.locationMapper = locationMapper || new TomlLocationMapper(this.config.tomlFilePath);
    this.dnsService = dnsService || new DnsService();
    this.geolocationService = geolocationService || new GeolocationService();
  }
  
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    
    console.log('🔧 Initializing Validator Location Service...');
    
    try {
      // Load validator mappings from TOML
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
    
    // Step 1: Resolve all hostnames to IPs in parallel (DNS rarely rate limits)
    console.log('🌐 Step 1: Resolving all hostnames to IPs...');
    const hostnameToIpMap = new Map<string, string>();
    
    for (const mapping of mappings) {
      try {
        const ip = await this.dnsService.resolveHostname(mapping.hostname);
        if (ip) {
          hostnameToIpMap.set(mapping.hostname, ip);
          this.dnsSuccesses++;
        }
      } catch (error) {
        console.warn(`DNS resolution failed for ${mapping.hostname}:`, error);
      }
      this.totalProcessed++;
    }
    
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
    return {
      nodeId: mapping.nodeId,
      dnsAddress: mapping.dnsAddress,
      hostname: mapping.hostname,
      port: mapping.port,
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
} 