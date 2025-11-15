import { ValidatorLocationService } from '../validator-location/ValidatorLocationService';
import { GeolocationService } from '../geolocation/GeolocationService';
import { DnsService } from '../dns/DnsService';
import { IValidatorLocationService } from '../validator-location/interfaces/IValidatorLocationService';
import { IGeolocationService } from '../geolocation/interfaces/IGeolocationService';
import { IDnsService } from '../dns/interfaces/IDnsService';
import { ValidatorLocation, ValidatorLocationStats } from '../validator-location/types';
import { GeolocationData } from '../geolocation/types';
import { IpcLocationMapper } from '../validator-location/mappers/IpcLocationMapper.js';

/**
 * Unified Location Service
 *
 * This service replaces all the old DNS and geolocation functionality:
 * - dns-mapper.ts
 * - enhanced-dns-processor.ts
 * - network-discovery.ts
 * - dns-cache.ts
 * - dns-parser.ts
 *
 * It provides a single, clean interface following SOLID principles
 * and relies solely on the ip-api service for geolocation data.
 *
 * Now uses IPC GetPeers to fetch validator IP addresses in real-time.
 */
export class UnifiedLocationService {
  private readonly validatorLocationService: IValidatorLocationService;
  private readonly geolocationService: IGeolocationService;
  private readonly dnsService: IDnsService;

  constructor(
    validatorLocationService?: IValidatorLocationService,
    geolocationService?: IGeolocationService,
    dnsService?: IDnsService
  ) {
    this.geolocationService = geolocationService || new GeolocationService();
    this.dnsService = dnsService || new DnsService();

    // Use IPC location mapper instead of TOML
    const socketPath = process.env.IPC_SOCKET_PATH;
    if (!socketPath) {
      throw new Error('IPC_SOCKET_PATH environment variable is required');
    }

    const ipcMapper = new IpcLocationMapper(socketPath);

    this.validatorLocationService = validatorLocationService || new ValidatorLocationService(
      ipcMapper,
      this.dnsService,
      this.geolocationService
    );
  }
  
  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    await this.validatorLocationService.initialize();
  }
  
  /**
   * Process all validator locations (replaces DNS mapper pre-processing)
   */
  async processAllValidatorLocations(): Promise<void> {
    await this.validatorLocationService.processAllValidatorLocations();
  }
  
  /**
   * EFFICIENT BATCH PROCESSING for validator initialization
   * 
   * This method uses the ip-api.com batch API to process all validators
   * much more efficiently than the sequential method above.
   * 
   * Benefits:
   * - 169 validators = 2 batch API calls instead of 169 individual calls
   * - Respects rate limits (15 batch requests per minute)
   * - Dramatically faster initialization
   */
  async processAllValidatorLocationsBatch(): Promise<{
    processed: number;
    successful: number;
    failed: number;
    timeMs: number;
  }> {
    const startTime = Date.now();
    console.log('🚀 Starting efficient batch validator location processing...');
    
    try {
      // Trigger the regular processing first to get basic validator data loaded
      await this.validatorLocationService.processAllValidatorLocations();
      
      // Get all validator locations that were processed
      const allValidators = await this.validatorLocationService.getAllValidatorLocations();
      console.log(`📋 Found ${allValidators.length} validators to enhance with batch geolocation`);
      
      if (allValidators.length === 0) {
        return {
          processed: 0,
          successful: 0,
          failed: 0,
          timeMs: Date.now() - startTime
        };
      }
      
      // Extract unique IPs for batch geolocation
      const uniqueIps: string[] = [...new Set(allValidators
        .map((validator: ValidatorLocation) => validator.ip)
        .filter((ip: string | undefined): ip is string => Boolean(ip) && ip !== 'unknown')
      )];
      
      console.log(`🌍 Need enhanced geolocation for ${uniqueIps.length} unique IPs...`);
      
      if (uniqueIps.length === 0) {
        console.log('⚠️ No valid IPs found for batch processing');
        return {
          processed: allValidators.length,
          successful: 0,
          failed: allValidators.length,
          timeMs: Date.now() - startTime
        };
      }
      
      // Batch geolocate IPs using ip-api.com batch API
      let ipToLocationMap: Map<string, GeolocationData>;
      
      // Use efficient batch geolocation if available
      if ('getLocationsBatch' in this.geolocationService) {
        console.log('📡 Using efficient ip-api.com batch API...');
        ipToLocationMap = await (this.geolocationService as any).getLocationsBatch(uniqueIps);
      } else {
        console.log('⚠️ Falling back to sequential geolocation...');
        ipToLocationMap = await this.geolocationService.getLocationsForIps(uniqueIps);
      }
      
      console.log(`✅ Got enhanced geolocation data for ${ipToLocationMap.size} IPs`);
      
      // Count successful enhancements
      let successful = 0;
      let failed = 0;
      
      for (const validator of allValidators) {
        if (validator.ip && ipToLocationMap.has(validator.ip)) {
          const geoData = ipToLocationMap.get(validator.ip);
          if (geoData) {
            // Enhanced geolocation data is available
            // The validator location service will have this data cached now
            successful++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
      }
      
      const timeMs = Date.now() - startTime;
      
      console.log('🎉 Batch validator location enhancement complete!');
      console.log(`📊 Results: ${successful} enhanced, ${failed} failed in ${timeMs}ms`);
      
      return {
        processed: allValidators.length,
        successful,
        failed,
        timeMs
      };
      
    } catch (error) {
      console.error('❌ Batch validator location processing failed:', error);
      throw error;
    }
  }
  
  // ===============================
  // Validator Location Methods
  // ===============================
  
  /**
   * Get complete location information for a validator
   * Replaces: DNSMapperService.getValidatorDNSInfo()
   */
  async getValidatorLocation(nodeId: string): Promise<ValidatorLocation | null> {
    return await this.validatorLocationService.getValidatorLocation(nodeId);
  }
  
  /**
   * Get location information for multiple validators
   * Replaces: DNSMapperService.batchProcessValidatorDNS()
   */
  async getValidatorLocations(nodeIds: string[]): Promise<Map<string, ValidatorLocation>> {
    return await this.validatorLocationService.getValidatorLocations(nodeIds);
  }
  
  /**
   * Get all validators with their locations
   */
  async getAllValidatorLocations(): Promise<ValidatorLocation[]> {
    return await this.validatorLocationService.getAllValidatorLocations();
  }
  
  /**
   * Check if validator has location data
   * Replaces: DNSMapperService.hasValidatorDNS()
   */
  hasValidatorLocation(nodeId: string): boolean {
    return this.validatorLocationService.hasValidatorLocation(nodeId);
  }
  
  /**
   * Refresh location data for a validator
   * Replaces: DNSMapperService.forceRefreshValidator()
   */
  async refreshValidatorLocation(nodeId: string): Promise<ValidatorLocation | null> {
    return await this.validatorLocationService.refreshValidatorLocation(nodeId);
  }
  
  // ===============================
  // DNS Resolution Methods
  // ===============================
  
  /**
   * Resolve hostname to IP address
   * Replaces: IntelligentDNSParser.resolveHostnameToIP()
   */
  async resolveHostname(hostname: string): Promise<string | null> {
    return await this.dnsService.resolveHostname(hostname);
  }
  
  /**
   * Resolve multiple hostnames
   */
  async resolveHostnames(hostnames: string[]): Promise<Map<string, string>> {
    return await this.dnsService.resolveHostnames(hostnames);
  }
  
  // ===============================
  // Geolocation Methods
  // ===============================
  
  /**
   * Get geolocation data for an IP address
   * Replaces: IntelligentDNSParser.getIPGeolocation()
   */
  async getLocationForIp(ip: string): Promise<GeolocationData | null> {
    return await this.geolocationService.getLocationForIp(ip);
  }
  
  /**
   * Get geolocation data for multiple IPs
   */
  async getLocationsForIps(ips: string[]): Promise<Map<string, GeolocationData>> {
    return await this.geolocationService.getLocationsForIps(ips);
  }
  
  // ===============================
  // Analysis Methods (replaces NetworkDiscoveryService)
  // ===============================
  
  /**
   * Get geographic distribution of validators
   * Replaces: NetworkDiscoveryService.getGeographicDistribution()
   */
  getGeographicDistribution(): Map<string, number> {
    return this.validatorLocationService.getGeographicDistribution();
  }
  
  /**
   * Get ISP distribution of validators
   * Replaces: NetworkDiscoveryService.getProviderDistribution()
   */
  getIspDistribution(): Map<string, number> {
    return this.validatorLocationService.getIspDistribution();
  }
  
  /**
   * Get validators by country
   */
  getValidatorsByCountry(country: string): ValidatorLocation[] {
    return this.validatorLocationService.getValidatorsByCountry(country);
  }
  
  /**
   * Get validators by city
   */
  getValidatorsByCity(city: string): ValidatorLocation[] {
    return this.validatorLocationService.getValidatorsByCity(city);
  }
  
  /**
   * Get validators by ISP
   */
  getValidatorsByIsp(isp: string): ValidatorLocation[] {
    return this.validatorLocationService.getValidatorsByIsp(isp);
  }
  
  // ===============================
  // Statistics and Cache Management
  // ===============================
  
  /**
   * Get comprehensive service statistics
   * Replaces: DNSMapperService.getStats() and others
   */
  getStats(): {
    validatorLocationStats: ValidatorLocationStats;
    dnsStats: any;
    geolocationStats: any;
  } {
    return {
      validatorLocationStats: this.validatorLocationService.getStats(),
      dnsStats: this.dnsService.getStats(),
      geolocationStats: this.geolocationService.getStats()
    };
  }
  
  /**
   * Clear all caches
   * Replaces: DNSCacheManager.clear() and others
   */
  clearCache(): void {
    this.validatorLocationService.clearCache();
  }
  
  /**
   * Cleanup expired cache entries
   */
  cleanupCache(): number {
    const dnsCleanup = this.dnsService.cleanupCache();
    const geoCleanup = this.geolocationService.cleanupCache();
    return dnsCleanup + geoCleanup;
  }
  
  // ===============================
  // Legacy Compatibility Methods
  // ===============================
  
  /**
   * Legacy method for backward compatibility
   * Maps old DNSParseResult format to new ValidatorLocation format
   */
  async parseDNSAddress(dnsAddress: string): Promise<{
    originalAddress: string;
    hostname: string;
    port: number;
    provider: string;
    locationInfo: {
      ip?: string;
      country?: string;
      region?: string;
      city?: string;
      isp?: string;
      coordinates?: { lat: number; lng: number };
    };
  } | null> {
    // Extract hostname and port from DNS address
    const [hostname, portStr] = dnsAddress.split(':');
    const port = parseInt(portStr) || 8000;
    
    // Resolve IP
    const ip = await this.resolveHostname(hostname);
    if (!ip) {
      return null;
    }
    
    // Get geolocation
    const geoData = await this.getLocationForIp(ip);
    
    // Extract provider from hostname (simple heuristic)
    const provider = this.extractProviderFromHostname(hostname);
    
    return {
      originalAddress: dnsAddress,
      hostname,
      port,
      provider,
      locationInfo: {
        ip,
        country: geoData?.country,
        region: geoData?.region,
        city: geoData?.city,
        isp: geoData?.isp,
        coordinates: geoData ? { lat: geoData.latitude, lng: geoData.longitude } : undefined
      }
    };
  }
  
  private extractProviderFromHostname(hostname: string): string {
    const parts = hostname.split('.');
    
    // Handle special cases
    if (hostname.includes('monadinfra')) return 'monadinfra';
    if (hostname.includes('aws') || hostname.includes('amazon')) return 'aws';
    if (hostname.includes('gcp') || hostname.includes('google')) return 'google-cloud';
    if (hostname.includes('azure')) return 'azure';
    if (hostname.includes('digitalocean')) return 'digitalocean';
    if (hostname.includes('vultr')) return 'vultr';
    if (hostname.includes('linode')) return 'linode';
    if (hostname.includes('hetzner')) return 'hetzner';
    
    // Use second-to-last domain part as provider
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    
    return 'unknown';
  }
} 