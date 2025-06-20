import { ValidatorLocationService } from '../validator-location/ValidatorLocationService';
import { GeolocationService } from '../geolocation/GeolocationService';
import { DnsService } from '../dns/DnsService';
import { IValidatorLocationService } from '../validator-location/interfaces/IValidatorLocationService';
import { IGeolocationService } from '../geolocation/interfaces/IGeolocationService';
import { IDnsService } from '../dns/interfaces/IDnsService';
import { ValidatorLocation, ValidatorLocationStats } from '../validator-location/types';
import { GeolocationData } from '../geolocation/types';

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
    this.validatorLocationService = validatorLocationService || new ValidatorLocationService(
      undefined, // Use default TomlLocationMapper
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