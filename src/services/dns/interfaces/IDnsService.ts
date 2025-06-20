import { DnsResolutionResult, DnsStats } from '../types';

export interface IDnsService {
  /**
   * Resolve hostname to IP address
   */
  resolveHostname(hostname: string): Promise<string | null>;
  
  /**
   * Resolve multiple hostnames in batch
   */
  resolveHostnames(hostnames: string[]): Promise<Map<string, string>>;
  
  /**
   * Get full resolution result with metadata
   */
  getResolutionResult(hostname: string): Promise<DnsResolutionResult | null>;
  
  /**
   * Get service statistics
   */
  getStats(): DnsStats;
  
  /**
   * Clear cache
   */
  clearCache(): void;
  
  /**
   * Cleanup expired cache entries
   */
  cleanupCache(): number;
} 