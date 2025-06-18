import { IntelligentDNSParser } from './dns-parser';
import { NetworkDiscoveryResult, ValidatorInfo, ProviderMetrics, DNSParseResult } from './types';

/**
 * Network Discovery Service for Monad Validator Analysis
 * Discovers and analyzes validator network topology and distribution
 */
export class NetworkDiscoveryService {
  private dnsParser: IntelligentDNSParser;
  private discoveryCache: Map<string, NetworkDiscoveryResult> = new Map();
  private validatorCache: Map<string, ValidatorInfo> = new Map();

  constructor() {
    this.dnsParser = new IntelligentDNSParser();
  }

  /**
   * Discover and analyze validator network from DNS addresses
   */
  async discoverNetwork(dnsAddresses: string[]): Promise<NetworkDiscoveryResult> {
    const cacheKey = this.generateCacheKey(dnsAddresses);
    
    // Check cache first
    const cached = this.discoveryCache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      return cached;
    }

    // Process all DNS addresses
    const parseResults: DNSParseResult[] = [];
    const batchSize = 10; // Process in batches to avoid overwhelming external services
    
    for (let i = 0; i < dnsAddresses.length; i += batchSize) {
      const batch = dnsAddresses.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(dns => this.dnsParser.parse(dns))
      );
      
      // Extract successful results
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          parseResults.push(result.value);
        } else {
          console.warn(`Failed to parse DNS ${batch[index]}:`, result.reason);
        }
      });
      
      // Add delay between batches to be respectful to external services
      if (i + batchSize < dnsAddresses.length) {
        await this.delay(1000);
      }
    }

    // Analyze results
    const result = this.analyzeNetworkTopology(parseResults);
    
    // Cache result
    this.discoveryCache.set(cacheKey, result);
    
    return result;
  }

  /**
   * Get detailed metrics for a specific provider
   */
  async getProviderMetrics(provider: string): Promise<ProviderMetrics | null> {
    const validators = Array.from(this.validatorCache.values())
      .filter(v => v.provider === provider);
    
    if (validators.length === 0) {
      return null;
    }

    const activeValidators = validators.filter(v => v.status === 'active');
    const locations = [...new Set(validators.map(v => v.locationInfo.city))];
    const datacenters = [...new Set(validators.map(v => v.locationInfo.datacenter))];

    return {
      provider,
      validatorCount: validators.length,
      activeValidators: activeValidators.length,
      avgPerformance: this.calculateAverageUptime(validators),
      regions: locations,
      datacenters,
      riskScore: this.calculateProviderRisk(validators),
      lastUpdated: new Date()
    };
  }

  /**
   * Get geographic distribution of validators
   */
  getGeographicDistribution(parseResults: DNSParseResult[]): Map<string, number> {
    const distribution = new Map<string, number>();
    
    parseResults.forEach(result => {
      const location = `${result.locationInfo.city}, ${result.locationInfo.country}`;
      distribution.set(location, (distribution.get(location) || 0) + 1);
    });
    
    return distribution;
  }

  /**
   * Get datacenter distribution of validators
   */
  getDatacenterDistribution(parseResults: DNSParseResult[]): Map<string, number> {
    const distribution = new Map<string, number>();
    
    parseResults.forEach(result => {
      const datacenter = result.locationInfo.datacenter;
      distribution.set(datacenter, (distribution.get(datacenter) || 0) + 1);
    });
    
    return distribution;
  }

  /**
   * Get provider distribution of validators
   */
  getProviderDistribution(parseResults: DNSParseResult[]): Map<string, number> {
    const distribution = new Map<string, number>();
    
    parseResults.forEach(result => {
      distribution.set(result.provider, (distribution.get(result.provider) || 0) + 1);
    });
    
    return distribution;
  }

  /**
   * Analyze network centralization risks
   */
  analyzeCentralizationRisks(result: NetworkDiscoveryResult): {
    providerRisk: number;
    geographicRisk: number;
    datacenterRisk: number;
    overallRisk: 'low' | 'medium' | 'high';
  } {
    // Calculate Herfindahl-Hirschman Index for each distribution
    const providerHHI = this.calculateHHI(result.providerDistribution);
    const geoHHI = this.calculateHHI(result.geographicDistribution);
    const dcHHI = this.calculateHHI(result.datacenterDistribution);

    // Normalize to 0-1 scale (lower is better)
    const providerRisk = Math.min(providerHHI / 10000, 1);
    const geographicRisk = Math.min(geoHHI / 10000, 1);
    const datacenterRisk = Math.min(dcHHI / 10000, 1);

    // Calculate overall risk
    const overallRiskScore = (providerRisk + geographicRisk + datacenterRisk) / 3;
    let overallRisk: 'low' | 'medium' | 'high';
    
    if (overallRiskScore < 0.3) {
      overallRisk = 'low';
    } else if (overallRiskScore < 0.6) {
      overallRisk = 'medium';
    } else {
      overallRisk = 'high';
    }

    return {
      providerRisk,
      geographicRisk,
      datacenterRisk,
      overallRisk
    };
  }

  /**
   * Find validators that might be using the same infrastructure
   */
  detectSharedInfrastructure(parseResults: DNSParseResult[]): {
    suspiciousGroups: DNSParseResult[][];
    riskLevel: 'low' | 'medium' | 'high';
  } {
    const ipGroups = new Map<string, DNSParseResult[]>();
    const asnGroups = new Map<string, DNSParseResult[]>();
    
    // Group by IP and ASN
    parseResults.forEach(result => {
      const ip = result.locationInfo.ip;
      if (ip && ip !== 'unknown') {
        if (!ipGroups.has(ip)) {
          ipGroups.set(ip, []);
        }
        ipGroups.get(ip)!.push(result);
      }
    });

    // Find suspicious groups (same IP with different providers)
    const suspiciousGroups: DNSParseResult[][] = [];
    
    ipGroups.forEach((validators, ip) => {
      if (validators.length > 1) {
        const providers = new Set(validators.map(v => v.provider));
        if (providers.size > 1) {
          // Different providers using same IP - suspicious
          suspiciousGroups.push(validators);
        }
      }
    });

    // Determine risk level
    const totalValidators = parseResults.length;
    const suspiciousValidators = suspiciousGroups.reduce((sum, group) => sum + group.length, 0);
    const suspiciousRatio = suspiciousValidators / totalValidators;
    
    let riskLevel: 'low' | 'medium' | 'high';
    if (suspiciousRatio < 0.1) {
      riskLevel = 'low';
    } else if (suspiciousRatio < 0.25) {
      riskLevel = 'medium';
    } else {
      riskLevel = 'high';
    }

    return { suspiciousGroups, riskLevel };
  }

  private analyzeNetworkTopology(parseResults: DNSParseResult[]): NetworkDiscoveryResult {
    const uniqueProviders = [...new Set(parseResults.map(r => r.provider))];
    const providerDistribution = this.getProviderDistribution(parseResults);
    const geographicDistribution = this.getGeographicDistribution(parseResults);
    const datacenterDistribution = this.getDatacenterDistribution(parseResults);

    // Calculate diversity score (Shannon entropy)
    const diversityScore = this.calculateDiversityScore(providerDistribution);
    
    // Calculate centralization risk
    const centralizationAnalysis = this.analyzeCentralizationRisks({
      totalValidators: parseResults.length,
      uniqueProviders,
      providerDistribution,
      geographicDistribution,
      datacenterDistribution,
      providerMetrics: {},
      diversityScore,
      centralizationRisk: 'low'
    });

    // Create provider metrics
    const providerMetrics: Record<string, ProviderMetrics> = {};
    uniqueProviders.forEach(provider => {
      const providerValidators = parseResults.filter(r => r.provider === provider);
      const validatorInfos: ValidatorInfo[] = providerValidators.map(r => ({
        validatorId: r.hostname.split('.')[0],
        dnsAddress: r.originalAddress,
        provider: r.provider,
        locationInfo: r.locationInfo,
        lastSeen: new Date(),
        status: 'active'
      }));
      
      // Create metrics synchronously based on current data
      providerMetrics[provider] = {
        provider,
        validatorCount: validatorInfos.length,
        activeValidators: validatorInfos.filter(v => v.status === 'active').length,
        avgPerformance: this.calculateAverageUptime(validatorInfos),
        regions: [...new Set(validatorInfos.map(v => `${v.locationInfo.city}, ${v.locationInfo.country}`))],
        datacenters: [...new Set(validatorInfos.map(v => v.locationInfo.datacenter))],
        riskScore: this.calculateProviderRisk(validatorInfos),
        lastUpdated: new Date()
      };
    });

    return {
      totalValidators: parseResults.length,
      uniqueProviders,
      providerDistribution,
      geographicDistribution,
      datacenterDistribution,
      providerMetrics,
      diversityScore,
      centralizationRisk: centralizationAnalysis.overallRisk
    };
  }

  private calculateHHI(distribution: Map<string, number>): number {
    const total = Array.from(distribution.values()).reduce((sum, count) => sum + count, 0);
    if (total === 0) return 0;
    
    let hhi = 0;
    distribution.forEach(count => {
      const marketShare = count / total;
      hhi += marketShare * marketShare * 10000; // HHI scale
    });
    
    return hhi;
  }

  private calculateAverageUptime(validators: ValidatorInfo[]): number {
    // This would need to be implemented based on actual uptime data
    // For now, return a placeholder
    const activeCount = validators.filter(v => v.status === 'active').length;
    return validators.length > 0 ? activeCount / validators.length : 0;
  }

  private calculateProviderRisk(validators: ValidatorInfo[]): number {
    // Calculate risk based on concentration and geographic distribution
    const totalValidators = validators.length;
    if (totalValidators === 0) return 0;
    
    // Higher validator count means higher risk if concentrated
    const concentrationRisk = Math.min(totalValidators / 50, 1); // Risk increases with count
    
    // Geographic diversity reduces risk
    const uniqueLocations = new Set(validators.map(v => `${v.locationInfo.city}, ${v.locationInfo.country}`));
    const diversityBonus = Math.min(uniqueLocations.size / 10, 1);
    
    // Final risk score (0-1, where 1 is highest risk)
    return Math.max(0, concentrationRisk - diversityBonus * 0.5);
  }

  private calculateDiversityScore(distribution: Map<string, number>): number {
    // Calculate Shannon diversity index
    const total = Array.from(distribution.values()).reduce((sum, count) => sum + count, 0);
    if (total === 0) return 0;
    
    let diversity = 0;
    distribution.forEach(count => {
      if (count > 0) {
        const proportion = count / total;
        diversity -= proportion * Math.log2(proportion);
      }
    });
    
    // Normalize to 0-1 scale
    const maxDiversity = Math.log2(distribution.size);
    return maxDiversity > 0 ? diversity / maxDiversity : 0;
  }

  private generateCacheKey(dnsAddresses: string[]): string {
    return Buffer.from(dnsAddresses.sort().join(',')).toString('base64');
  }

  private isCacheValid(result: NetworkDiscoveryResult): boolean {
    // Cache for 1 hour
    const cacheAge = Date.now() - new Date().getTime();
    return cacheAge < 3600000;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Export network topology for visualization
   */
  exportTopologyData(result: NetworkDiscoveryResult): {
    nodes: Array<{ id: string; type: string; label: string; size: number }>;
    edges: Array<{ source: string; target: string; weight: number }>;
  } {
    const nodes: Array<{ id: string; type: string; label: string; size: number }> = [];
    const edges: Array<{ source: string; target: string; weight: number }> = [];

    // Create provider nodes
    result.providerDistribution.forEach((count, provider) => {
      nodes.push({
        id: `provider_${provider}`,
        type: 'provider',
        label: provider,
        size: count
      });
    });

    // Create location nodes
    result.geographicDistribution.forEach((count, location) => {
      nodes.push({
        id: `location_${location}`,
        type: 'location',
        label: location,
        size: count
      });
    });

    return { nodes, edges };
  }
} 