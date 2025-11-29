export interface GeolocationData {
  ip: string;
  country: string;
  region: string;
  city: string;
  latitude: number;
  longitude: number;
  isp: string;
  organization: string;
  timezone: string;
  countryCode: string;
  regionCode: string;
}

export interface GeolocationCacheEntry {
  data: GeolocationData;
  cachedAt: Date;
  ttl: number;
}

export interface GeolocationProviderResponse {
  success: boolean;
  data?: GeolocationData;
  error?: string;
  rateLimited?: boolean;
}

export interface GeolocationServiceConfig {
  cacheConfig: {
    defaultTtl: number;
    maxEntries: number;
    cleanupInterval: number;
  };
  rateLimitConfig: {
    requestsPerMinute: number;
    burstLimit: number;
    backoffMultiplier: number;
  };
}

export interface GeolocationStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  apiCalls: number;
  errors: number;
  rateLimitHits: number;
  avgResponseTime: number;
  hitRate: number;
} 