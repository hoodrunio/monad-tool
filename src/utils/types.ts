export interface LocationInfo {
  ip: string;
  country: string;
  region: string;
  city: string;
  datacenter: string;
  isp: string;
  coordinates?: {
    lat: number;
    lng: number;
  };
}

export interface DNSParseResult {
  originalAddress: string;
  hostname: string;
  port: number;
  provider: string;
  networkType: string;
  network: string;
  instance: string;
  locationInfo: LocationInfo;
  rawDomainParts: string[];
  parsingMethod: string;
}

export interface ValidatorInfo {
  validatorId: string;
  dnsAddress: string;
  provider: string;
  locationInfo: LocationInfo;
  lastSeen: Date;
  status: 'active' | 'inactive' | 'unknown';
}

export interface GeolocationResponse {
  status: 'success' | 'fail';
  message?: string;
  continent?: string;
  continentCode?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  regionName?: string;
  city?: string;
  district?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  offset?: number;
  currency?: string;
  isp?: string;
  org?: string;
  as?: string;
  asname?: string;
  reverse?: string;
  mobile?: boolean;
  proxy?: boolean;
  hosting?: boolean;
  query?: string;
}

export interface NetworkDiscoveryResult {
  totalValidators: number;
  uniqueProviders: string[];
  providerDistribution: Map<string, number>;
  geographicDistribution: Map<string, number>;
  datacenterDistribution: Map<string, number>;
  providerMetrics: Record<string, ProviderMetrics>;
  diversityScore: number;
  centralizationRisk: 'low' | 'medium' | 'high';
}

export interface DNSCacheEntry {
  hostname: string;
  parseResult: DNSParseResult;
  timestamp: Date;
  ttl: number;
}

export interface ProviderMetrics {
  provider: string;
  validatorCount: number;
  activeValidators: number;
  avgPerformance: number;
  regions: string[];
  datacenters: string[];
  riskScore: number;
  lastUpdated: Date;
} 