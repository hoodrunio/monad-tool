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
    const results: LocationProcessResult[] = [];
    const batchSize = 50;
    
    console.log(`📋 Processing ${mappings.length} validators in batches of ${batchSize}`);
    
    for (let i = 0; i < mappings.length; i += batchSize) {
      const batch = mappings.slice(i, i + batchSize);
      
      const batchPromises = batch.map(mapping => this.processValidatorLocation(mapping));
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
          
          // Cache successful results
          if (result.value.success && this.config.enableCaching) {
            this.validatorLocations.set(result.value.validator.nodeId, result.value.validator);
          }
        } else {
          // Create error result
          results.push({
            success: false,
            validator: this.createBasicValidatorLocation(batch[index]),
            error: result.reason?.message || 'Unknown processing error',
            processingTime: 0
          });
        }
      });
      
      // Progress logging
      const processed = Math.min(i + batchSize, mappings.length);
      const successful = results.filter(r => r.success).length;
      console.log(`Processed ${processed}/${mappings.length} validators (${successful} successful)`);
      
      // Add delay between batches
      if (i + batchSize < mappings.length) {
        await this.delay(this.config.processingDelay);
      }
    }
    
    console.log(`✅ Completed processing: ${results.filter(r => r.success).length}/${results.length} successful`);
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