import { DnsResolverResponse } from '../types';

export interface IDnsResolver {
  /**
   * Resolve hostname to IP address
   */
  resolve(hostname: string): Promise<DnsResolverResponse>;
  
  /**
   * Get resolver statistics
   */
  getStats(): {
    resolutionsMade: number;
    failures: number;
    timeouts: number;
    avgResponseTime: number;
  };
  
  /**
   * Reset resolver statistics
   */
  resetStats(): void;
} 