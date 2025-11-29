import { DnsResolutionResult, DnsCacheEntry } from '../types';

export interface IDnsCache {
  /**
   * Get cached DNS resolution result for a hostname
   */
  get(hostname: string): DnsResolutionResult | null;
  
  /**
   * Set DNS resolution result in cache
   */
  set(hostname: string, result: DnsResolutionResult, ttl?: number): void;
  
  /**
   * Check if hostname is cached and not expired
   */
  has(hostname: string): boolean;
  
  /**
   * Remove cached data for a hostname
   */
  delete(hostname: string): boolean;
  
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