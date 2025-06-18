import { execSync } from 'child_process';
import { DNSParseResult, LocationInfo, GeolocationResponse } from './types';

/**
 * Circuit breaker for external API calls
 */
class CircuitBreaker {
  private failures = 0;
  private lastFailTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private maxFailures = 5,
    private resetTimeoutMs = 60000 // 1 minute
  ) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailTime > this.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    
    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.reset();
      }
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
  
  private recordFailure() {
    this.failures++;
    this.lastFailTime = Date.now();
    if (this.failures >= this.maxFailures) {
      this.state = 'open';
    }
  }
  
  private reset() {
    this.failures = 0;
    this.state = 'closed';
  }
}

/**
 * Rate limiter for API requests
 */
class RateLimiter {
  private requests: number[] = [];
  
  constructor(
    private maxRequests = 10,
    private windowMs = 60000 // 1 minute window
  ) {}
  
  async checkLimit(): Promise<void> {
    const now = Date.now();
    // Remove requests outside the window
    this.requests = this.requests.filter(time => now - time < this.windowMs);
    
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = Math.min(...this.requests);
      const waitTime = this.windowMs - (now - oldestRequest);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    this.requests.push(now);
  }
}

/**
 * Intelligent DNS Parser for Monad Validator URLs
 * Extracts provider names and uses external services for location/datacenter info
 */
export class IntelligentDNSParser {
  private providerPatterns: Map<string, RegExp> = new Map();
  private knownTLDs: Set<string> = new Set();
  private circuitBreaker = new CircuitBreaker(3, 30000); // More conservative settings
  private rateLimiter = new RateLimiter(5, 60000); // 5 requests per minute
  private geolocationCache = new Map<string, any>();
  private pendingRequests = new Map<string, Promise<any>>();
  
  constructor() {
    this.initializePatterns();
    this.initializeKnownTLDs();
  }

  /**
   * Parse validator DNS to extract provider name and network information
   */
  async parse(dnsAddress: string): Promise<DNSParseResult> {
    const { hostname, port } = this.extractHostnameAndPort(dnsAddress);
    
    // Extract provider name using intelligent parsing
    const provider = this.extractProviderName(hostname);
    
    // Get location info from external DNS services with fallback
    const locationInfo = await this.getLocationInfoSafe(hostname);
    
    // Extract network information
    const networkInfo = this.extractNetworkInfo(hostname);
    
    return {
      originalAddress: dnsAddress,
      hostname,
      port,
      provider,
      networkType: networkInfo.type,
      network: networkInfo.network,
      instance: networkInfo.instance,
      locationInfo,
      rawDomainParts: hostname.split('.'),
      parsingMethod: this.getParsingMethod(hostname)
    };
  }

  /**
   * Extract provider name using intelligent pattern matching
   */
  private extractProviderName(hostname: string): string {
    const parts = hostname.split('.');
    
    // Handle special cases first
    if (hostname.includes('monadinfra.com')) {
      return 'monadinfra';
    }
    
    // For standard domain patterns like validator.domain.com
    if (parts.length >= 2) {
      const domain = parts[parts.length - 2]; // Get second-to-last part
      
      // Handle special domain patterns
      if (domain === 'amazonaws' || domain === 'googleusercontent') {
        return this.extractCloudProvider(hostname);
      }
      
      // Handle subdomain patterns like monad.testnet.provider.com
      if (parts.length >= 3 && (parts[0].includes('monad') || parts[1].includes('testnet'))) {
        return parts[parts.length - 2];
      }
      
      return domain;
    }
    
    return 'unknown';
  }

  /**
   * Extract network information from hostname
   */
  private extractNetworkInfo(hostname: string): {
    type: string;
    network: string;
    instance: string;
  } {
    const parts = hostname.split('.');
    const firstPart = parts[0];
    
    // Analyze the subdomain for network info
    let type = 'validator';
    let network = 'testnet';
    let instance = '';
    
    if (firstPart.includes('testnet')) {
      network = 'testnet';
    } else if (firstPart.includes('mainnet')) {
      network = 'mainnet';
    }
    
    // Extract instance information
    const instanceMatch = firstPart.match(/(\d+)$/);
    if (instanceMatch) {
      instance = instanceMatch[1];
    }
    
    // Determine validator type
    if (firstPart.includes('val')) {
      type = 'validator';
    } else if (firstPart.includes('rpc')) {
      type = 'rpc';
    } else if (firstPart.includes('api')) {
      type = 'api';
    }
    
    return { type, network, instance };
  }

  /**
   * Get location info with circuit breaker and fallback
   */
  private async getLocationInfoSafe(hostname: string): Promise<LocationInfo> {
    try {
      // Use nslookup and dig to get IP and then lookup location
      const ip = await this.resolveHostnameToIP(hostname);
      if (!ip) {
        return this.getUnknownLocationInfo();
      }
      
      // Check cache first
      if (this.geolocationCache.has(ip)) {
        const cached = this.geolocationCache.get(ip);
        return {
          ip,
          country: cached.country || 'unknown',
          region: cached.region || 'unknown',
          city: cached.city || 'unknown',
          datacenter: cached.datacenter || this.extractDatacenterFromHostname(hostname),
          isp: cached.isp || 'unknown',
          coordinates: cached.coordinates
        };
      }
      
      // Check for pending request to avoid duplicate calls
      if (this.pendingRequests.has(ip)) {
        const geoInfo = await this.pendingRequests.get(ip);
        return {
          ip,
          country: geoInfo.country || 'unknown',
          region: geoInfo.region || 'unknown',
          city: geoInfo.city || 'unknown',
          datacenter: geoInfo.datacenter || this.extractDatacenterFromHostname(hostname),
          isp: geoInfo.isp || 'unknown',
          coordinates: geoInfo.coordinates
        };
      }
      
      // Get geographic information using IP geolocation with circuit breaker
      const geoInfoPromise = this.getIPGeolocationSafe(ip);
      this.pendingRequests.set(ip, geoInfoPromise);
      
      try {
        const geoInfo = await geoInfoPromise;
        this.geolocationCache.set(ip, geoInfo);
        
        return {
          ip,
          country: geoInfo.country || 'unknown',
          region: geoInfo.region || 'unknown',
          city: geoInfo.city || 'unknown',
          datacenter: geoInfo.datacenter || this.extractDatacenterFromHostname(hostname),
          isp: geoInfo.isp || 'unknown',
          coordinates: geoInfo.coordinates
        };
      } finally {
        this.pendingRequests.delete(ip);
      }
    } catch (error) {
      console.warn(`Failed to get location info for ${hostname}:`, error);
      return this.getUnknownLocationInfo();
    }
  }

  /**
   * Get location and datacenter information from external DNS services
   */
  private async getLocationInfo(hostname: string): Promise<LocationInfo> {
    try {
      // Use nslookup and dig to get IP and then lookup location
      const ip = await this.resolveHostnameToIP(hostname);
      if (!ip) {
        return this.getUnknownLocationInfo();
      }
      
      // Get geographic information using IP geolocation
      const geoInfo = await this.getIPGeolocation(ip);
      
      return {
        ip,
        country: geoInfo.country || 'unknown',
        region: geoInfo.region || 'unknown',
        city: geoInfo.city || 'unknown',
        datacenter: geoInfo.datacenter || this.extractDatacenterFromHostname(hostname),
        isp: geoInfo.isp || 'unknown',
        coordinates: geoInfo.coordinates
      };
    } catch (error) {
      console.warn(`Failed to get location info for ${hostname}:`, error);
      return this.getUnknownLocationInfo();
    }
  }

  /**
   * Resolve hostname to IP using nslookup
   */
  private async resolveHostnameToIP(hostname: string): Promise<string | null> {
    try {
      const output = execSync(`nslookup ${hostname}`, { 
        encoding: 'utf8',
        timeout: 5000 
      });
      
      // Parse nslookup output to extract IP
      const ipMatch = output.match(/Address: (\d+\.\d+\.\d+\.\d+)/);
      return ipMatch ? ipMatch[1] : null;
    } catch (error) {
      console.warn(`nslookup failed for ${hostname}:`, error);
      return null;
    }
  }

  /**
   * Get IP geolocation information with circuit breaker and rate limiting
   */
  private async getIPGeolocationSafe(ip: string): Promise<{
    country?: string;
    region?: string;
    city?: string;
    datacenter?: string;
    isp?: string;
    coordinates?: { lat: number; lng: number };
  }> {
    try {
      // Apply rate limiting
      await this.rateLimiter.checkLimit();
      
      // Use circuit breaker for external API call
      const result = await this.circuitBreaker.execute(async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
        
        try {
          // Using a free geolocation service (in production, use a paid service)
          const response = await fetch(
            `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,lat,lon`,
            { 
              signal: controller.signal,
              headers: {
                'User-Agent': 'monad-analytics/1.0'
              }
            }
          );
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            throw new Error(`Geolocation API failed: ${response.status}`);
          }
          
          const data = await response.json() as GeolocationResponse;
          
          if (data.status !== 'success') {
            throw new Error('Geolocation lookup failed');
          }
          
          return {
            country: data.country,
            region: data.regionName,
            city: data.city,
            isp: data.isp,
            datacenter: this.extractDatacenterFromISP(data.org || data.isp),
            coordinates: data.lat && data.lon ? { lat: data.lat, lng: data.lon } : undefined
          };
        } finally {
          clearTimeout(timeoutId);
        }
      });
      
      return result || {};
    } catch (error) {
      // Log at info level to reduce noise
      console.info(`IP geolocation failed for ${ip}:`, error instanceof Error ? error.message : 'Unknown error');
      
      // Return fallback data based on IP ranges if possible
      return this.getFallbackGeolocation(ip);
    }
  }

  /**
   * Get IP geolocation information
   * Note: In production, this should use a proper geolocation service
   */
  private async getIPGeolocation(ip: string): Promise<{
    country?: string;
    region?: string;
    city?: string;
    datacenter?: string;
    isp?: string;
    coordinates?: { lat: number; lng: number };
  }> {
    try {
      // Using a free geolocation service (in production, use a paid service)
      const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,lat,lon`);
      
      if (!response.ok) {
        throw new Error(`Geolocation API failed: ${response.status}`);
      }
      
      const data = await response.json() as GeolocationResponse;
      
      if (data.status !== 'success') {
        throw new Error('Geolocation lookup failed');
      }
      
      return {
        country: data.country,
        region: data.regionName,
        city: data.city,
        isp: data.isp,
        datacenter: this.extractDatacenterFromISP(data.org || data.isp),
        coordinates: data.lat && data.lon ? { lat: data.lat, lng: data.lon } : undefined
      };
    } catch (error) {
      console.warn(`IP geolocation failed for ${ip}:`, error);
      return {};
    }
  }

  /**
   * Extract datacenter information from ISP/organization name
   */
  private extractDatacenterFromISP(orgName: string): string {
    if (!orgName) return 'unknown';
    
    const dcPatterns = [
      /amazon.*web.*services/i,
      /google.*cloud/i,
      /microsoft.*azure/i,
      /digitalocean/i,
      /linode/i,
      /vultr/i,
      /hetzner/i,
      /ovh/i
    ];
    
    for (const pattern of dcPatterns) {
      if (pattern.test(orgName)) {
        return orgName.toLowerCase();
      }
    }
    
    return 'unknown';
  }

  /**
   * Extract datacenter hints from hostname patterns
   */
  private extractDatacenterFromHostname(hostname: string): string {
    // Look for common datacenter/location codes in hostname
    const dcPatterns = [
      /aws|amazon/i,
      /gcp|google/i,
      /azure|microsoft/i,
      /do|digitalocean/i,
      /hetzner|htz/i,
      /ovh/i
    ];
    
    for (const pattern of dcPatterns) {
      if (pattern.test(hostname)) {
        return pattern.source.toLowerCase().replace(/[|\\]/g, '');
      }
    }
    
    return 'unknown';
  }

  /**
   * Extract cloud provider information from hostname
   */
  private extractCloudProvider(hostname: string): string {
    if (hostname.includes('amazonaws.com')) return 'aws';
    if (hostname.includes('googleusercontent.com')) return 'gcp';
    if (hostname.includes('azure.com')) return 'azure';
    if (hostname.includes('digitalocean.com')) return 'digitalocean';
    
    return 'unknown';
  }

  /**
   * Extract hostname and port from DNS address
   */
  private extractHostnameAndPort(dnsAddress: string): { hostname: string; port: number } {
    const parts = dnsAddress.split(':');
    const hostname = parts[0];
    const port = parts[1] ? parseInt(parts[1]) : 8000;
    
    return { hostname, port };
  }

  /**
   * Get unknown location info as fallback
   */
  private getUnknownLocationInfo(): LocationInfo {
    return {
      ip: 'unknown',
      country: 'unknown',
      region: 'unknown',
      city: 'unknown',
      datacenter: 'unknown',
      isp: 'unknown'
    };
  }

  /**
   * Determine which parsing method was used
   */
  private getParsingMethod(hostname: string): string {
    if (hostname.includes('monadinfra.com')) return 'monadinfra-pattern';
    if (hostname.includes('amazonaws.com') || hostname.includes('googleusercontent.com')) return 'cloud-provider';
    if (hostname.split('.').length >= 3) return 'subdomain-analysis';
    return 'domain-extraction';
  }

  /**
   * Get fallback geolocation data based on IP ranges
   */
  private getFallbackGeolocation(ip: string): {
    country?: string;
    region?: string;
    city?: string;
    datacenter?: string;
    isp?: string;
    coordinates?: { lat: number; lng: number };
  } {
    // Basic IP range analysis for common cloud providers
    const ipParts = ip.split('.').map(Number);
    
    // AWS IP ranges (simplified detection)
    if ((ipParts[0] === 52 || ipParts[0] === 54 || ipParts[0] === 3) && ipParts[1] >= 0) {
      return {
        country: 'US',
        region: 'unknown',
        city: 'unknown',
        datacenter: 'AWS',
        isp: 'Amazon Web Services'
      };
    }
    
    // Google Cloud IP ranges
    if ((ipParts[0] === 35 || ipParts[0] === 34) && ipParts[1] >= 0) {
      return {
        country: 'US',
        region: 'unknown',
        city: 'unknown',
        datacenter: 'Google Cloud',
        isp: 'Google'
      };
    }
    
    // DigitalOcean ranges
    if (ipParts[0] === 159 || ipParts[0] === 138) {
      return {
        country: 'US',
        region: 'unknown',
        city: 'unknown',
        datacenter: 'DigitalOcean',
        isp: 'DigitalOcean'
      };
    }
    
    // Default fallback
    return {
      country: 'unknown',
      region: 'unknown', 
      city: 'unknown',
      datacenter: 'unknown',
      isp: 'unknown'
    };
  }

  /**
   * Initialize known provider patterns for better recognition
   */
  private initializePatterns(): void {
    // Add patterns for known providers that might have complex naming
    this.providerPatterns.set('monadinfra', /monadinfra\.com/);
    this.providerPatterns.set('aws', /amazonaws\.com/);
    this.providerPatterns.set('gcp', /googleusercontent\.com/);
    this.providerPatterns.set('azure', /azure\.com/);
  }

  /**
   * Initialize known TLDs for better domain parsing
   */
  private initializeKnownTLDs(): void {
    this.knownTLDs.add('com');
    this.knownTLDs.add('io');
    this.knownTLDs.add('net');
    this.knownTLDs.add('org');
    this.knownTLDs.add('xyz');
    this.knownTLDs.add('tech');
    this.knownTLDs.add('dev');
    this.knownTLDs.add('cloud');
    this.knownTLDs.add('systems');
    this.knownTLDs.add('services');
    this.knownTLDs.add('finance');
    this.knownTLDs.add('one');
    this.knownTLDs.add('me');
    this.knownTLDs.add('de');
    this.knownTLDs.add('re');
    this.knownTLDs.add('jp');
    this.knownTLDs.add('top');
    this.knownTLDs.add('pro');
    this.knownTLDs.add('zone');
    this.knownTLDs.add('space');
    this.knownTLDs.add('club');
    this.knownTLDs.add('land');
    this.knownTLDs.add('rocks');
  }
} 