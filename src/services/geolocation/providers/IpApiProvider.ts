import * as http from 'http';
import * as url from 'url';
import { IGeolocationProvider } from '../interfaces/IGeolocationProvider';
import { GeolocationData, GeolocationProviderResponse } from '../types';

interface IpApiResponse {
  status: string;
  country: string;
  countryCode: string;
  region: string;
  regionName: string;
  city: string;
  lat: number;
  lon: number;
  timezone: string;
  isp: string;
  org: string;
  query: string;
  message?: string;
}

interface BatchRequest {
  query: string;
  fields?: string;
}

export class IpApiProvider implements IGeolocationProvider {
  private readonly baseUrl = 'http://ip-api.com/json';
  private readonly batchUrl = 'http://ip-api.com/batch';
  private readonly requestsPerMinute = 45; // Individual API
  private readonly batchRequestsPerMinute = 15; // Batch API
  private readonly maxBatchSize = 100;
  
  private requestHistory: number[] = [];
  private batchRequestHistory: number[] = [];
  private requestsMade = 0;
  private batchRequestsMade = 0;
  private rateLimitHits = 0;
  private errors = 0;
  private totalResponseTime = 0;
  
  canMakeRequest(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Clean old requests from history
    this.requestHistory = this.requestHistory.filter(time => time > oneMinuteAgo);
    
    // Check if we're within rate limits
    return this.requestHistory.length < this.requestsPerMinute;
  }

  canMakeBatchRequest(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Clean old batch requests from history
    this.batchRequestHistory = this.batchRequestHistory.filter(time => time > oneMinuteAgo);
    
    // Check if we're within batch rate limits
    return this.batchRequestHistory.length < this.batchRequestsPerMinute;
  }
  
  async getLocation(ip: string): Promise<GeolocationProviderResponse> {
    if (!this.canMakeRequest()) {
      this.rateLimitHits++;
      return {
        success: false,
        error: 'Rate limit exceeded',
        rateLimited: true
      };
    }
    
    const startTime = Date.now();
    
    try {
      const data = await this.makeRequest(ip);
      const responseTime = Date.now() - startTime;
      
      this.requestsMade++;
      this.totalResponseTime += responseTime;
      this.requestHistory.push(Date.now());
      
      if (data.status !== 'success') {
        this.errors++;
        return {
          success: false,
          error: data.message || 'Geolocation lookup failed'
        };
      }
      
      const geolocationData: GeolocationData = {
        ip: data.query,
        country: data.country,
        region: data.regionName,
        city: data.city,
        latitude: data.lat,
        longitude: data.lon,
        isp: data.isp,
        organization: data.org,
        timezone: data.timezone,
        countryCode: data.countryCode,
        regionCode: data.region
      };
      
      return {
        success: true,
        data: geolocationData
      };
      
    } catch (error) {
      this.errors++;
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * BATCH API: Process multiple IP addresses in a single request
   * Up to 100 IPs per request, much more efficient for validator initialization
   */
  async getLocationsBatch(ips: string[]): Promise<Map<string, GeolocationProviderResponse>> {
    const results = new Map<string, GeolocationProviderResponse>();
    
    if (ips.length === 0) {
      return results;
    }

    // Process IPs in batches of 100 (max allowed by ip-api.com)
    const batches: string[][] = [];
    for (let i = 0; i < ips.length; i += this.maxBatchSize) {
      batches.push(ips.slice(i, i + this.maxBatchSize));
    }

    console.log(`🚀 Processing ${ips.length} IPs in ${batches.length} batch(es) using ip-api.com batch API`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`📦 Processing batch ${i + 1}/${batches.length} (${batch.length} IPs)...`);

      if (!this.canMakeBatchRequest()) {
        console.warn(`⚠️ Rate limit hit, waiting before batch ${i + 1}`);
        await this.waitForRateLimit();
      }

      try {
        const batchResults = await this.makeBatchRequest(batch);
        
        // Process each result in the batch
        batchResults.forEach((data, index) => {
          const originalIp = batch[index];
          
          if (data.status !== 'success') {
            results.set(originalIp, {
              success: false,
              error: data.message || 'Geolocation lookup failed'
            });
            return;
          }

          const geolocationData: GeolocationData = {
            ip: data.query,
            country: data.country,
            region: data.regionName,
            city: data.city,
            latitude: data.lat,
            longitude: data.lon,
            isp: data.isp,
            organization: data.org,
            timezone: data.timezone,
            countryCode: data.countryCode,
            regionCode: data.region
          };

          results.set(originalIp, {
            success: true,
            data: geolocationData
          });
        });

        console.log(`✅ Batch ${i + 1} completed: ${batchResults.length} locations processed`);

      } catch (error) {
        console.error(`❌ Batch ${i + 1} failed:`, error);
        
        // Mark all IPs in this batch as failed
        batch.forEach(ip => {
          results.set(ip, {
            success: false,
            error: error instanceof Error ? error.message : 'Batch request failed'
          });
        });
      }

      // Small delay between batches to be respectful to the API
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`🎉 Batch processing complete: ${results.size} total results`);
    return results;
  }

  private async makeBatchRequest(ips: string[]): Promise<IpApiResponse[]> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const batchData: BatchRequest[] = ips.map(ip => ({
        query: ip,
        fields: '61439' // Same fields as individual API
      }));

      const payload = JSON.stringify(batchData);
      const parsedUrl = url.parse(this.batchUrl);
      
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.path + '?fields=61439',
        method: 'POST',
        timeout: 30000, // Longer timeout for batch requests
        headers: {
          'User-Agent': 'Monad-Analytics/1.0',
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Connection': 'close'
        }
      };
      
      const req = http.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const responseTime = Date.now() - startTime;
            this.batchRequestsMade++;
            this.totalResponseTime += responseTime;
            this.batchRequestHistory.push(Date.now());

            if (res.statusCode === 429) {
              this.rateLimitHits++;
              reject(new Error('Rate limit exceeded (429)'));
              return;
            }

            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
              return;
            }
            
            const response = JSON.parse(data) as IpApiResponse[];
            resolve(response);
          } catch (error) {
            reject(new Error('Failed to parse batch response JSON'));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Batch request timeout'));
      });
      
      req.write(payload);
      req.end();
    });
  }

  private async makeRequest(ip: string): Promise<IpApiResponse> {
    return new Promise((resolve, reject) => {
      const apiUrl = `${this.baseUrl}/${ip}?fields=61439`;
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
          'Connection': 'close'
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
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
              return;
            }
            
            const response = JSON.parse(data) as IpApiResponse;
            resolve(response);
          } catch (error) {
            reject(new Error('Failed to parse response JSON'));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.end();
    });
  }

  private async waitForRateLimit(): Promise<void> {
    // Wait 60 seconds for rate limit to reset
    console.log('⏳ Waiting 60 seconds for rate limit to reset...');
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
  
  getStats(): {
    requestsMade: number;
    batchRequestsMade: number;
    rateLimitHits: number;
    errors: number;
    avgResponseTime: number;
  } {
    const totalRequests = this.requestsMade + this.batchRequestsMade;
    return {
      requestsMade: this.requestsMade,
      batchRequestsMade: this.batchRequestsMade,
      rateLimitHits: this.rateLimitHits,
      errors: this.errors,
      avgResponseTime: totalRequests > 0 ? this.totalResponseTime / totalRequests : 0
    };
  }
  
  resetStats(): void {
    this.requestsMade = 0;
    this.batchRequestsMade = 0;
    this.rateLimitHits = 0;
    this.errors = 0;
    this.totalResponseTime = 0;
    this.requestHistory = [];
    this.batchRequestHistory = [];
  }
} 