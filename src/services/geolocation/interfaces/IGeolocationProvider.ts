import { GeolocationData, GeolocationProviderResponse } from '../types';

export interface IGeolocationProvider {
  /**
   * Get geolocation data for an IP address
   */
  getLocation(ip: string): Promise<GeolocationProviderResponse>;
  
  /**
   * Check if the provider can handle more requests (rate limiting)
   */
  canMakeRequest(): boolean;
  
  /**
   * Get provider-specific statistics
   */
  getStats(): {
    requestsMade: number;
    rateLimitHits: number;
    errors: number;
    avgResponseTime: number;
  };
  
  /**
   * Reset provider statistics
   */
  resetStats(): void;
} 