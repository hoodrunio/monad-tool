import { Request, Response } from 'express';
import { UnifiedLocationService } from '../../services/unified-location/UnifiedLocationService';
import { ValidatorService } from '../../services/unified-validator/ValidatorService';
import { FocusedLogProcessor } from '../../log-processor/enhanced-processor';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';

export class DNSAnalyticsController {
  private locationService: UnifiedLocationService;
  private validatorService: ValidatorService;
  private logProcessor: FocusedLogProcessor;

  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {
    this.locationService = new UnifiedLocationService();
    this.validatorService = new ValidatorService();
    
    // Initialize the log processor for DNS analytics
    const config = {
      batchSize: 100,
      batchTimeoutMs: 5000,
      maxRetries: 3,
      enableQCParsing: true,
      enableVoteChainAnalysis: false,
      enableGeographicIntelligence: true,
      parallelProcessing: true,
      maxConcurrentBatches: 2
    };

    this.logProcessor = new FocusedLogProcessor();
  }

  /**
   * Parse and analyze a single validator DNS address
   * GET /api/dns/analyze?address=validator.example.com:8000
   */
  async analyzeDNSAddress(req: Request, res: Response): Promise<void> {
    try {
      const { address } = req.query;
      
      if (!address || typeof address !== 'string') {
        res.status(400).json({
          success: false,
          error: 'DNS address parameter is required'
        });
        return;
      }

      const result = await this.locationService.parseDNSAddress(address);
      
      if (!result) {
        res.status(404).json({
          success: false,
          error: 'Failed to analyze DNS address'
        });
        return;
      }
      
      res.json({
        success: true,
        data: {
          originalAddress: address,
          parsedData: result,
          analysis: {
            provider: result.provider,
            location: `${result.locationInfo.city}, ${result.locationInfo.country}`,
            datacenter: result.locationInfo.isp,
            coordinates: result.locationInfo.coordinates,
            networkType: 'validator',
            parsingMethod: 'unified-location-service'
          }
        }
      });

    } catch (error) {
      console.error('DNS analysis error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to analyze DNS address'
      });
    }
  }

  /**
   * Analyze multiple validator DNS addresses in batch
   * POST /api/dns/batch-analyze
   * Body: { validators: [{ validatorId: "id1", dnsAddress: "addr1" }, ...] }
   */
  async batchAnalyzeDNS(req: Request, res: Response): Promise<void> {
    try {
      const { validators } = req.body;
      
      if (!Array.isArray(validators)) {
        res.status(400).json({
          success: false,
          error: 'Validators array is required'
        });
        return;
      }

      // Validate input format
      for (const validator of validators) {
        if (!validator.validatorId || !validator.dnsAddress) {
          res.status(400).json({
            success: false,
            error: 'Each validator must have validatorId and dnsAddress fields'
          });
          return;
        }
      }

      // Process batch using new architecture
      const results = [];
      for (const validator of validators) {
        try {
          const result = await this.locationService.parseDNSAddress(validator.dnsAddress);
          if (result) {
            results.push({
              validatorId: validator.validatorId,
              originalAddress: validator.dnsAddress,
              parsedData: result,
              analysis: {
                provider: result.provider,
                location: `${result.locationInfo.city}, ${result.locationInfo.country}`,
                datacenter: result.locationInfo.isp,
                coordinates: result.locationInfo.coordinates
              }
            });
          }
        } catch (error) {
          console.warn(`Failed to process ${validator.dnsAddress}:`, error);
        }
      }
      
      res.json({
        success: true,
        data: {
          totalProcessed: validators.length,
          results
        }
      });

    } catch (error) {
      console.error('Batch DNS analysis error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to analyze DNS addresses'
      });
    }
  }

  /**
   * Get network topology analysis
   * GET /api/dns/network-topology
   */
  async getNetworkTopology(req: Request, res: Response): Promise<void> {
    try {
      const geoDistribution = this.validatorService.getGeographicDistribution();
      const ispDistribution = this.validatorService.getIspDistribution();
      const stats = this.validatorService.getStats();
      
      const topology = {
        totalValidators: stats.totalValidators,
        validatorsWithLocation: stats.validatorsWithLocation,
        locationCoverage: stats.locationCoverage,
        geographicDistribution: Object.fromEntries(geoDistribution),
        providerDistribution: Object.fromEntries(ispDistribution),
        diversityScore: this.calculateDiversityScore(geoDistribution),
        centralizationRisk: this.calculateCentralizationRisk(ispDistribution, stats.totalValidators)
      };

      res.json({
        success: true,
        data: topology
      });

    } catch (error) {
      console.error('Network topology error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get network topology'
      });
    }
  }

  /**
   * Get centralization risk analysis
   * GET /api/dns/centralization-risks
   */
  async getCentralizationRisks(req: Request, res: Response): Promise<void> {
    try {
      const geoDistribution = this.validatorService.getGeographicDistribution();
      const ispDistribution = this.validatorService.getIspDistribution();
      const stats = this.validatorService.getStats();
      
      const providerRisks = this.analyzeProviderRisks(ispDistribution, stats.totalValidators);
      const geoRisks = this.analyzeGeographicRisks(geoDistribution, stats.totalValidators);
      
      const risks = {
        centralizationRisk: this.calculateCentralizationRisk(ispDistribution, stats.totalValidators),
        diversityScore: this.calculateDiversityScore(geoDistribution),
        providerRisks: Object.fromEntries(
          Array.from(ispDistribution.entries()).map(([provider, count]) => [
            provider,
            {
              validatorCount: count,
              riskScore: (count / stats.totalValidators) * 100,
              avgPerformance: 85, // Default value - could be enhanced
              regions: [`Region for ${provider}`],
              datacenters: [provider]
            }
          ])
        ),
        riskFactors: {
          providerConcentration: Math.max(...Array.from(ispDistribution.values())) / stats.totalValidators * 100,
          geographicConcentration: Math.max(...Array.from(geoDistribution.values())) / stats.totalValidators * 100,
          infrastructureDiversity: this.calculateDiversityScore(ispDistribution)
        }
      };

      res.json({
        success: true,
        data: risks
      });

    } catch (error) {
      console.error('Centralization risks error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get centralization risks'
      });
    }
  }

  /**
   * Get provider distribution statistics
   * GET /api/dns/provider-distribution
   */
  async getProviderDistribution(req: Request, res: Response): Promise<void> {
    try {
      const ispDistribution = this.validatorService.getIspDistribution();
      const stats = this.validatorService.getStats();
      const totalValidators = stats.totalValidators;
      
      const distribution = Array.from(ispDistribution.entries()).map(([provider, count]) => ({
        provider,
        validatorCount: count,
        percentage: totalValidators > 0 ? (count / totalValidators) * 100 : 0,
        avgPerformance: 85, // Default value - could be enhanced with actual performance data
        regions: [`Region for ${provider}`], // Could be enhanced with actual region data
        riskScore: (count / totalValidators) * 100
      }));

      res.json({
        success: true,
        data: {
          totalValidators,
          distribution: distribution.sort((a, b) => b.validatorCount - a.validatorCount),
          diversityIndex: this.calculateDiversityScore(ispDistribution),
          centralizationRisk: this.calculateCentralizationRisk(ispDistribution, totalValidators)
        }
      });

    } catch (error) {
      console.error('Provider distribution error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get provider distribution'
      });
    }
  }

  /**
   * Get geographic distribution of validators
   * GET /api/dns/geographic-distribution
   */
  async getGeographicDistribution(req: Request, res: Response): Promise<void> {
    try {
      const geoDistribution = this.validatorService.getGeographicDistribution();
      const stats = this.validatorService.getStats();
      const totalValidators = stats.totalValidators;
      
      const distribution = Array.from(geoDistribution.entries()).map(([location, count]) => ({
        location,
        validatorCount: count,
        percentage: totalValidators > 0 ? (count / totalValidators) * 100 : 0
      }));

      res.json({
        success: true,
        data: {
          totalValidators,
          distribution: distribution.sort((a, b) => b.validatorCount - a.validatorCount),
          diversityIndex: this.calculateDiversityScore(geoDistribution)
        }
      });

    } catch (error) {
      console.error('Geographic distribution error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get geographic distribution'
      });
    }
  }

  /**
   * Get DNS cache statistics
   * GET /api/dns/cache-stats
   */
  async getDNSCacheStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = this.locationService.getStats();
      
      const cacheStats = {
        totalEntries: stats.dnsStats.totalRequests || 0,
        hitRate: stats.dnsStats.hitRate || 0,
        geolocationStats: stats.geolocationStats,
        dnsStats: stats.dnsStats
      };
      
      res.json({
        success: true,
        data: cacheStats
      });

    } catch (error) {
      console.error('DNS cache stats error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get DNS cache statistics'
      });
    }
  }

  /**
   * Clear DNS cache
   * POST /api/dns/clear-cache
   */
  async clearDNSCache(req: Request, res: Response): Promise<void> {
    try {
      this.locationService.clearCache();
      this.validatorService.clearLocationCache();
      
      res.json({
        success: true,
        message: 'DNS cache cleared successfully'
      });

    } catch (error) {
      console.error('DNS cache clear error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to clear DNS cache'
      });
    }
  }

  /**
   * Get validator infrastructure details
   * GET /api/dns/validator-infrastructure/:validatorId
   */
  async getValidatorInfrastructure(req: Request, res: Response): Promise<void> {
    try {
      const { validatorId } = req.params;
      
      if (!validatorId) {
        res.status(400).json({
          success: false,
          error: 'Validator ID is required'
        });
        return;
      }

      const validator = await this.validatorService.getValidator(validatorId);
      
      if (!validator) {
        res.status(404).json({
          success: false,
          error: 'Validator infrastructure not found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          validatorId: validator.nodeId,
          stake: validator.stake,
          position: validator.position,
          location: validator.location,
          lastUpdated: validator.lastUpdated
        }
      });

    } catch (error) {
      console.error('Validator infrastructure error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get validator infrastructure'
      });
    }
  }

  /**
   * Search validators by provider or location
   * GET /api/dns/search?provider=example&location=US
   */
  async searchValidators(req: Request, res: Response): Promise<void> {
    try {
      const { provider, location, datacenter } = req.query;
      
      let results = [];
      
      if (provider) {
        const validatorsByProvider = await this.validatorService.getValidatorsByIsp(provider as string);
        results.push(...validatorsByProvider);
      }
      
      if (location) {
        const validatorsByCountry = await this.validatorService.getValidatorsByCountry(location as string);
        const validatorsByCity = await this.validatorService.getValidatorsByCity(location as string);
        results.push(...validatorsByCountry, ...validatorsByCity);
      }

      // Remove duplicates based on nodeId
      const uniqueResults = results.filter((validator, index, self) => 
        self.findIndex(v => v.nodeId === validator.nodeId) === index
      );

      res.json({
        success: true,
        data: {
          totalFound: uniqueResults.length,
          validators: uniqueResults.map(v => ({
            validatorId: v.nodeId,
            stake: v.stake,
            position: v.position,
            location: v.location,
            lastUpdated: v.lastUpdated
          }))
        }
      });

    } catch (error) {
      console.error('Validator search error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to search validators'
      });
    }
  }

  /**
   * Health check for DNS analytics service
   * GET /api/dns/health
   */
  async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const stats = this.locationService.getStats();
      const isHealthy = stats.dnsStats.totalRequests >= 0;
      
      res.json({
        success: true,
        status: isHealthy ? 'healthy' : 'degraded',
        data: {
          cacheEntries: stats.dnsStats.totalRequests || 0,
          cacheHitRate: stats.dnsStats.hitRate || 0,
          timestamp: new Date().toISOString(),
          architecture: 'unified-location-service'
        }
      });

    } catch (error) {
      console.error('DNS health check error:', error);
      res.status(500).json({
        success: false,
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'DNS analytics service is unhealthy'
      });
    }
  }

  // ===============================
  // Private Helper Methods
  // ===============================

  private calculateDiversityScore(distribution: Map<string, number>): number {
    const total = Array.from(distribution.values()).reduce((sum, count) => sum + count, 0);
    if (total === 0) return 0;
    
    let diversity = 0;
    distribution.forEach(count => {
      if (count > 0) {
        const proportion = count / total;
        diversity -= proportion * Math.log2(proportion);
      }
    });
    
    const maxDiversity = Math.log2(distribution.size);
    return maxDiversity > 0 ? diversity / maxDiversity : 0;
  }

  private calculateCentralizationRisk(distribution: Map<string, number>, totalValidators: number): string {
    if (totalValidators === 0) return 'low';
    
    const maxConcentration = Math.max(...Array.from(distribution.values())) / totalValidators;
    
    if (maxConcentration > 0.5) return 'high';
    if (maxConcentration > 0.3) return 'medium';
    return 'low';
  }

  private analyzeProviderRisks(distribution: Map<string, number>, totalValidators: number): any {
    const risks: any = {};
    distribution.forEach((count, provider) => {
      const concentration = count / totalValidators;
      risks[provider] = {
        concentration,
        riskLevel: concentration > 0.3 ? 'high' : concentration > 0.2 ? 'medium' : 'low'
      };
    });
    return risks;
  }

  private analyzeGeographicRisks(distribution: Map<string, number>, totalValidators: number): any {
    const risks: any = {};
    distribution.forEach((count, location) => {
      const concentration = count / totalValidators;
      risks[location] = {
        concentration,
        riskLevel: concentration > 0.4 ? 'high' : concentration > 0.25 ? 'medium' : 'low'
      };
    });
    return risks;
  }
} 