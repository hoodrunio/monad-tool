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
  status: string;
  country: string;
  regionName: string;
  city: string;
  isp: string;
  org: string;
  lat: number;
  lon: number;
}

export interface NetworkDiscoveryResult {
  totalValidators: number;
  uniqueProviders: string[];
  providerDistribution: Map<string, number>;
  geographicDistribution: Map<string, number>;
  datacenterDistribution: Map<string, number>;
}

export interface DNSCacheEntry {
  hostname: string;
  parseResult: DNSParseResult;
  timestamp: Date;
  ttl: number;
}

export interface ProviderMetrics {
  provider: string;
  totalValidators: number;
  activeValidators: number;
  averageUptime: number;
  locations: string[];
  datacenters: string[];
  lastUpdated: Date;
} 