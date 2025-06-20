export interface DnsResolutionResult {
  hostname: string;
  ip: string;
  resolvedAt: Date;
  ttl: number;
}

export interface DnsCacheEntry {
  result: DnsResolutionResult;
  cachedAt: Date;
  ttl: number;
}

export interface DnsResolverResponse {
  success: boolean;
  ip?: string;
  error?: string;
  timeout?: boolean;
}

export interface DnsServiceConfig {
  cacheConfig: {
    defaultTtl: number;
    maxEntries: number;
    cleanupInterval: number;
  };
  resolverConfig: {
    timeout: number;
    retries: number;
    preferredResolvers: string[];
  };
}

export interface DnsStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  resolutionAttempts: number;
  failures: number;
  timeouts: number;
  avgResolutionTime: number;
  hitRate: number;
} 