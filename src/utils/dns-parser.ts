import { execSync } from 'child_process';
import { DNSParseResult, LocationInfo, GeolocationResponse } from './types';
import * as http from 'http';
import * as url from 'url';

interface CircuitBreakerState {
  isOpen: boolean;
  failureCount: number;
  lastFailure: number;
  threshold: number;
  timeout: number;
}

/**
 * Intelligent DNS Parser for Monad Validator URLs
 * Extracts provider names and uses external services for location/datacenter info
 */
export class IntelligentDNSParser {
  private providerPatterns: Map<string, RegExp> = new Map();
  private knownTLDs: Set<string> = new Set();
  private circuitBreaker: CircuitBreakerState;
  private rateLimiter: {
    lastCall: number;
    callCount: number;
    windowStart: number;
    maxCallsPerWindow: number;
    windowSize: number;
  };
  private requestQueue: Array<{
    ip: string;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private isProcessingQueue: boolean = false;
  private maxConcurrentRequests: number = 1; // Limit to 1 concurrent request to prevent memory issues
  
  constructor() {
    this.initializePatterns();
    this.initializeKnownTLDs();
    
    // Initialize circuit breaker
    this.circuitBreaker = {
      isOpen: false,
      failureCount: 0,
      lastFailure: 0,
      threshold: 5, // Open after 5 failures
      timeout: 30000 // 30 seconds timeout
    };
    
    // Initialize rate limiter for ip-api.com (45 requests per minute)
    this.rateLimiter = {
      lastCall: 0,
      callCount: 0,
      windowStart: Date.now(),
      maxCallsPerWindow: 40, // Leave some buffer below the 45 limit
      windowSize: 60000 // 1 minute window
    };
  }

  /**
   * Parse validator DNS to extract provider name and network information
   */
  async parse(dnsAddress: string): Promise<DNSParseResult> {
    const { hostname, port } = this.extractHostnameAndPort(dnsAddress);
    
    // Extract provider name using intelligent parsing
    const provider = this.extractProviderName(hostname);
    
    // Get location info from external DNS services
    const locationInfo = await this.getLocationInfo(hostname);
    
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
  private async getIPGeolocation(ip: string): Promise<{
    country?: string;
    region?: string;
    city?: string;
    datacenter?: string;
    isp?: string;
    coordinates?: { lat: number; lng: number };
  }> {
    // Check circuit breaker first
    if (this.isCircuitBreakerOpen()) {
      throw new Error('Circuit breaker is open');
    }

    // Use queuing for rate limiting instead of immediate rejection
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ ip, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Process the request queue with proper rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.requestQueue.length > 0) {
        // Check if we can make a request
        if (!this.canMakeAPICall()) {
          // Wait until we can make the next request
          const waitTime = this.getWaitTime();
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        // Check circuit breaker again
        if (this.isCircuitBreakerOpen()) {
          // Reject all queued requests
          while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift()!;
            request.reject(new Error('Circuit breaker is open'));
          }
          break;
        }

        const request = this.requestQueue.shift()!;
        
        try {
          const result = await this.makeGeolocationRequest(request.ip);
          request.resolve(result);
        } catch (error) {
          // Return empty object instead of rejecting to prevent unhandled rejections
          request.resolve({});
        }
      }
    } catch (error) {
      // Handle any unexpected errors in queue processing
      console.error('Error processing request queue:', error);
      
      // Reject all remaining requests
      while (this.requestQueue.length > 0) {
        const request = this.requestQueue.shift()!;
        request.resolve({}); // Return empty object instead of rejecting
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Make the actual geolocation API request using Node.js http module to avoid WebAssembly memory issues
   */
  private async makeGeolocationRequest(ip: string): Promise<{
    country?: string;
    region?: string;
    city?: string;
    datacenter?: string;
    isp?: string;
    coordinates?: { lat: number; lng: number };
  }> {
    return new Promise((resolve, reject) => {
      const apiUrl = `http://ip-api.com/json/${ip}?fields=61439`;
      const parsedUrl = url.parse(apiUrl);
      
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.path,
        method: 'GET',
        timeout: 10000,
        headers: {
          'User-Agent': 'Monad-Analytics/1.0',
          'Accept': 'application/json',
          'Connection': 'close' // Ensure connection is closed after request
        }
      };

      const req = http.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`Geolocation API failed: ${res.statusCode}`));
              return;
            }
            
            const response = JSON.parse(data) as GeolocationResponse;
            
            if (response.status !== 'success') {
              reject(new Error(response.message || 'Geolocation lookup failed'));
              return;
            }

            // Success - reset circuit breaker and record API call
            this.resetCircuitBreaker();
            this.recordAPICall();
            
            resolve({
              country: response.country,
              region: response.regionName,
              city: response.city,
              isp: response.isp,
              datacenter: this.extractDatacenterFromISP(response.org || response.isp || ''),
              coordinates: response.lat && response.lon ? { lat: response.lat, lng: response.lon } : undefined
            });
          } catch (error) {
            reject(new Error('Failed to parse geolocation response'));
          }
        });
      });
      
      req.on('error', (error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Record failure for circuit breaker (only if not already open)
        if (!this.circuitBreaker.isOpen) {
          this.recordFailure();
        }
        
        console.warn(`IP geolocation failed for ${ip}:`, errorMessage);
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.end();
    });
  }

  /**
   * Check if circuit breaker is open
   */
  private isCircuitBreakerOpen(): boolean {
    if (!this.circuitBreaker.isOpen) {
      return false;
    }

    // Check if timeout has passed
    if (Date.now() - this.circuitBreaker.lastFailure > this.circuitBreaker.timeout) {
      this.circuitBreaker.isOpen = false;
      this.circuitBreaker.failureCount = 0;
      return false;
    }

    return true;
  }

  /**
   * Record a failure for circuit breaker
   */
  private recordFailure(): void {
    // Don't increment failures if circuit breaker is already open
    if (this.circuitBreaker.isOpen) {
      return;
    }

    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailure = Date.now();

    if (this.circuitBreaker.failureCount >= this.circuitBreaker.threshold) {
      this.circuitBreaker.isOpen = true;
      console.warn(`Circuit breaker opened after ${this.circuitBreaker.failureCount} failures`);
    }
  }

  /**
   * Reset circuit breaker after successful call
   */
  private resetCircuitBreaker(): void {
    this.circuitBreaker.failureCount = 0;
    this.circuitBreaker.isOpen = false;
  }

  /**
   * Check if we can make an API call within rate limits
   */
  private canMakeAPICall(): boolean {
    const now = Date.now();
    
    // Reset window if needed
    if (now - this.rateLimiter.windowStart > this.rateLimiter.windowSize) {
      this.rateLimiter.windowStart = now;
      this.rateLimiter.callCount = 0;
    }

    // Check if we're within rate limits
    if (this.rateLimiter.callCount >= this.rateLimiter.maxCallsPerWindow) {
      return false;
    }

    // Enforce minimum delay between calls
    const timeSinceLastCall = now - this.rateLimiter.lastCall;
    if (timeSinceLastCall < 1500) { // 1.5 seconds between calls
      return false;
    }

    return true;
  }

  /**
   * Record successful API call for rate limiting
   */
  private recordAPICall(): void {
    this.rateLimiter.lastCall = Date.now();
    this.rateLimiter.callCount++;
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

  /**
   * Calculate how long to wait before making the next request
   */
  private getWaitTime(): number {
    const now = Date.now();
    const timeSinceLastCall = now - this.rateLimiter.lastCall;
    const minDelay = 1500; // 1.5 seconds minimum between calls
    
    if (timeSinceLastCall < minDelay) {
      return minDelay - timeSinceLastCall;
    }
    
    // Check if we need to wait for the rate limit window to reset
    const timeInCurrentWindow = now - this.rateLimiter.windowStart;
    if (timeInCurrentWindow < this.rateLimiter.windowSize && 
        this.rateLimiter.callCount >= this.rateLimiter.maxCallsPerWindow) {
      return this.rateLimiter.windowSize - timeInCurrentWindow;
    }
    
    return 0;
  }
} 