import { GeolocationData, GeolocationStats } from '../types';

export interface IGeolocationService {
  /**
   * Get geolocation data for an IP address
   */
  getLocationForIp(ip: string): Promise<GeolocationData | null>;
  
  /**
   * Get geolocation data for multiple IPs in batch
   */
  getLocationsForIps(ips: string[]): Promise<Map<string, GeolocationData>>;
  
  /**
   * Get service statistics
   */
  getStats(): GeolocationStats;
  
  /**
   * Clear cache
   */
  clearCache(): void;
  
  /**
   * Cleanup expired cache entries
   */
  cleanupCache(): number;
} 