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

export class IpApiProvider implements IGeolocationProvider {
  private readonly baseUrl = 'http://ip-api.com/json';
  private readonly requestsPerMinute = 45;
  private readonly burstLimit = 5;
  
  private requestHistory: number[] = [];
  private requestsMade = 0;
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
  
  getStats(): {
    requestsMade: number;
    rateLimitHits: number;
    errors: number;
    avgResponseTime: number;
  } {
    return {
      requestsMade: this.requestsMade,
      rateLimitHits: this.rateLimitHits,
      errors: this.errors,
      avgResponseTime: this.requestsMade > 0 ? this.totalResponseTime / this.requestsMade : 0
    };
  }
  
  resetStats(): void {
    this.requestsMade = 0;
    this.rateLimitHits = 0;
    this.errors = 0;
    this.totalResponseTime = 0;
    this.requestHistory = [];
  }
} 