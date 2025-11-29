import { GeolocationData, GeolocationCacheEntry } from '../types';

export interface IGeolocationCache {
  /**
   * Get cached geolocation data for an IP
   */
  get(ip: string): GeolocationData | null;
  
  /**
   * Set geolocation data in cache
   */
  set(ip: string, data: GeolocationData, ttl?: number): void;
  
  /**
   * Check if IP is cached and not expired
   */
  has(ip: string): boolean;
  
  /**
   * Remove cached data for an IP
   */
  delete(ip: string): boolean;
  
  /**
   * Clear all cached data
   */
  clear(): void;
  
  /**
   * Clean up expired entries
   */
  cleanup(): number;
  
  /**
   * Get cache statistics
   */
  getStats(): {
    totalEntries: number;
    validEntries: number;
    expiredEntries: number;
    memoryUsage: number;
  };
} 