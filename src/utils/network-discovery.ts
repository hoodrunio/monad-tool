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
    if (validators.length === 0) return 0;
    
    // Calculate uptime based on multiple factors
    let totalUptimeScore = 0;
    
    validators.forEach(validator => {
      let uptimeScore = 0;
      
      // Factor 1: Basic availability (active status)
      if (validator.status === 'active') {
        uptimeScore += 40; // Base score for being active
      }
      
      // Factor 2: Recent activity (last seen within reasonable time)
      const timeSinceLastSeen = Date.now() - validator.lastSeen.getTime();
      const hoursSinceLastSeen = timeSinceLastSeen / (1000 * 60 * 60);
      
      if (hoursSinceLastSeen <= 1) {
        uptimeScore += 30; // Very recent activity
      } else if (hoursSinceLastSeen <= 6) {
        uptimeScore += 20; // Recent activity
      } else if (hoursSinceLastSeen <= 24) {
        uptimeScore += 10; // Moderate activity
      }
      // No points for older activity
      
      // Factor 3: Infrastructure quality (bonus for good infrastructure)
      if (validator.locationInfo.datacenter && validator.locationInfo.datacenter !== 'unknown') {
        uptimeScore += 15; // Proper datacenter hosting
      }
      
      if (validator.provider && validator.provider !== 'unknown') {
        // Known cloud providers get bonus for reliability
        const reliableProviders = ['aws', 'gcp', 'azure', 'digital-ocean', 'linode', 'vultr'];
        const isReliableProvider = reliableProviders.some(provider => 
          validator.provider.toLowerCase().includes(provider)
        );
        if (isReliableProvider) {
          uptimeScore += 10;
        } else {
          uptimeScore += 5; // Any known provider gets some points
        }
      }
      
      // Factor 4: Geographic distribution bonus
      if (validator.locationInfo.country && validator.locationInfo.country !== 'unknown') {
        uptimeScore += 5; // Proper geographic identification
      }
      
      // Normalize to 0-100 scale
      totalUptimeScore += Math.min(uptimeScore, 100);
    });
    
    return totalUptimeScore / validators.length;
  }

  private calculateProviderRisk(validators: ValidatorInfo[]): number {
    if (validators.length === 0) return 0;
    
    // Calculate risk based on multiple factors
    const totalValidators = validators.length;
    
    // Factor 1: Concentration risk (higher validator count = higher risk)
    const concentrationRisk = Math.min(totalValidators / 100, 1); // Risk increases with count, max at 100
    
    // Factor 2: Geographic diversity (more locations = lower risk)
    const uniqueCountries = new Set(
      validators
        .map(v => v.locationInfo.country)
        .filter(country => country && country !== 'unknown')
    );
    const countryDiversityBonus = Math.min(uniqueCountries.size / 10, 0.8); // Max 80% reduction
    
    // Factor 3: Infrastructure diversity (multiple datacenters = lower risk)
    const uniqueDatacenters = new Set(
      validators
        .map(v => v.locationInfo.datacenter)
        .filter(dc => dc && dc !== 'unknown')
    );
    const datacenterDiversityBonus = Math.min(uniqueDatacenters.size / 5, 0.6); // Max 60% reduction
    
    // Factor 4: Activity distribution (all active is higher risk than mixed)
    const activeCount = validators.filter(v => v.status === 'active').length;
    const activityDistributionRisk = activeCount / totalValidators; // Higher if all are active
    
    // Factor 5: Recent activity concentration
    const recentActivityCount = validators.filter(v => {
      const timeSinceLastSeen = Date.now() - v.lastSeen.getTime();
      return timeSinceLastSeen < (6 * 60 * 60 * 1000); // Within 6 hours
    }).length;
    const recentActivityRisk = recentActivityCount / totalValidators;
    
    // Calculate final risk score (0-1, where 1 is highest risk)
    const baseRisk = (concentrationRisk + activityDistributionRisk + recentActivityRisk) / 3;
    const diversityReduction = (countryDiversityBonus + datacenterDiversityBonus) / 2;
    
    return Math.max(0, Math.min(1, baseRisk - diversityReduction));
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

  /**
   * Calculate comprehensive provider metrics with real performance data
   */
  async getProviderMetricsEnhanced(
    provider: string,
    includeHistoricalData: boolean = false
  ): Promise<ProviderMetrics & {
    performanceMetrics: {
      avgResponseTime: number;
      uptimePercentage: number;
      reliabilityScore: number;
      performanceTrend: 'improving' | 'stable' | 'declining';
    };
  } | null> {
    const baseMetrics = await this.getProviderMetrics(provider);
    if (!baseMetrics) return null;
    
    const validators = Array.from(this.validatorCache.values())
      .filter(v => v.provider === provider);
    
    // Calculate performance metrics
    const avgResponseTime = this.calculateAverageResponseTime(validators);
    const uptimePercentage = this.calculateAverageUptime(validators);
    const reliabilityScore = this.calculateReliabilityScore(validators);
    const performanceTrend = this.calculatePerformanceTrend(validators);
    
    return {
      ...baseMetrics,
      performanceMetrics: {
        avgResponseTime,
        uptimePercentage,
        reliabilityScore,
        performanceTrend
      }
    };
  }

  private calculateAverageResponseTime(validators: ValidatorInfo[]): number {
    // Since we don't have actual response time data, calculate based on infrastructure quality
    let totalScore = 0;
    
    validators.forEach(validator => {
      let responseScore = 100; // Start with baseline
      
      // Cloud providers typically have better response times
      const cloudProviders = ['aws', 'gcp', 'azure', 'digital-ocean'];
      const isCloudProvider = cloudProviders.some(provider => 
        validator.provider.toLowerCase().includes(provider)
      );
      
      if (isCloudProvider) {
        responseScore -= 20; // Better response time
      }
      
      // Datacenters typically have better response times than residential
      if (validator.locationInfo.datacenter && validator.locationInfo.datacenter !== 'unknown') {
        responseScore -= 15;
      }
      
      // Recent activity suggests better connectivity
      const timeSinceLastSeen = Date.now() - validator.lastSeen.getTime();
      const hoursSinceLastSeen = timeSinceLastSeen / (1000 * 60 * 60);
      
      if (hoursSinceLastSeen <= 1) {
        responseScore -= 10;
      }
      
      totalScore += Math.max(50, responseScore); // Min 50ms, realistic baseline
    });
    
    return validators.length > 0 ? totalScore / validators.length : 200;
  }

  private calculateReliabilityScore(validators: ValidatorInfo[]): number {
    if (validators.length === 0) return 0;
    
    let totalReliability = 0;
    
    validators.forEach(validator => {
      let reliabilityScore = 0;
      
      // Active status is primary reliability indicator
      if (validator.status === 'active') {
        reliabilityScore += 60;
      }
      
      // Recent activity indicates reliability
      const timeSinceLastSeen = Date.now() - validator.lastSeen.getTime();
      const hoursSinceLastSeen = timeSinceLastSeen / (1000 * 60 * 60);
      
      if (hoursSinceLastSeen <= 1) {
        reliabilityScore += 25;
      } else if (hoursSinceLastSeen <= 6) {
        reliabilityScore += 15;
      } else if (hoursSinceLastSeen <= 24) {
        reliabilityScore += 5;
      }
      
      // Infrastructure quality affects reliability
      if (validator.locationInfo.datacenter && validator.locationInfo.datacenter !== 'unknown') {
        reliabilityScore += 10;
      }
      
      if (validator.provider && validator.provider !== 'unknown') {
        reliabilityScore += 5;
      }
      
      totalReliability += Math.min(100, reliabilityScore);
    });
    
    return totalReliability / validators.length;
  }

  private calculatePerformanceTrend(validators: ValidatorInfo[]): 'improving' | 'stable' | 'declining' {
    // Since we don't have historical data, make educated guess based on current status
    const activeCount = validators.filter(v => v.status === 'active').length;
    const activeRatio = validators.length > 0 ? activeCount / validators.length : 0;
    
    const recentActivityCount = validators.filter(v => {
      const timeSinceLastSeen = Date.now() - v.lastSeen.getTime();
      return timeSinceLastSeen < (1 * 60 * 60 * 1000); // Within 1 hour
    }).length;
    const recentActivityRatio = validators.length > 0 ? recentActivityCount / validators.length : 0;
    
    // High activity and mostly active = improving or stable
    if (activeRatio >= 0.9 && recentActivityRatio >= 0.8) {
      return 'improving';
    } else if (activeRatio >= 0.7 && recentActivityRatio >= 0.5) {
      return 'stable';
    } else {
      return 'declining';
    }
  }
} 