export interface ValidatorMapping {
  nodeId: string;
  dnsAddress: string;
  hostname: string;
  port: number;
}

export interface ValidatorLocation {
  nodeId: string;
  dnsAddress: string;
  hostname: string;
  port: number;
  validatorName?: string;
  validatorWebsite?: string;
  validatorLogoUrl?: string;
  validatorDescription?: string;
  validatorXHandle?: string;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  isp?: string;
  organization?: string;
  timezone?: string;
  countryCode?: string;
  regionCode?: string;
  resolvedAt?: Date;
  lastUpdated: Date;
}

export interface ValidatorLocationStats {
  totalValidators: number;
  validatorsWithLocation: number;
  validatorsWithoutLocation: number;
  locationCoverage: number;
  dnsResolutionSuccessRate: number;
  geolocationSuccessRate: number;
  avgProcessingTime: number;
  cacheHitRate: number;
}

export interface ValidatorLocationServiceConfig {
  tomlFilePath: string;
  enableCaching: boolean;
  batchSize: number;
  processingDelay: number;
  retryFailedLookups: boolean;
  maxRetries: number;
}

export interface LocationProcessResult {
  success: boolean;
  validator: ValidatorLocation;
  error?: string;
  processingTime: number;
} 