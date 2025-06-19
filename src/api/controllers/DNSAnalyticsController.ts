import { Request, Response } from 'express';
import { 
  EnhancedDNSProcessor,
  createEnhancedDNSProcessor,
  NetworkDiscoveryResult,
  DNSParseResult
} from '../../utils';
import { ProcessingConfig } from '../../log-processor/types';
import { FocusedLogProcessor } from '../../log-processor/enhanced-processor';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';

export class DNSAnalyticsController {
  private enhancedDnsProcessor: EnhancedDNSProcessor;
  private logProcessor: FocusedLogProcessor;

  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {
    this.enhancedDnsProcessor = createEnhancedDNSProcessor();
    
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

      const result = await this.enhancedDnsProcessor.processValidatorDNS(address);
      
      res.json({
        success: true,
        data: {
          originalAddress: address,
          parsedData: result,
          analysis: {
            provider: result.provider,
            location: `${result.locationInfo.city}, ${result.locationInfo.country}`,
            datacenter: result.locationInfo.datacenter,
            coordinates: result.locationInfo.coordinates,
            networkType: result.networkType,
            parsingMethod: result.parsingMethod
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

      const results = await this.enhancedDnsProcessor.processBatchValidatorDNS(validators);
      
      res.json({
        success: true,
        data: {
          totalProcessed: validators.length,
          results: results.map((result, index) => ({
            validatorId: validators[index].validatorId,
            originalAddress: validators[index].dnsAddress,
            parsedData: result,
            analysis: {
              provider: result.provider,
              location: `${result.locationInfo.city}, ${result.locationInfo.country}`,
              datacenter: result.locationInfo.datacenter,
              coordinates: result.locationInfo.coordinates
            }
          }))
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
      const topology = await this.enhancedDnsProcessor.analyzeNetworkTopology();
      
      if (!topology) {
        res.status(404).json({
          success: false,
          error: 'Network topology data not available'
        });
        return;
      }

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
      const topology = await this.enhancedDnsProcessor.analyzeNetworkTopology();
      
      if (!topology) {
        res.status(404).json({
          success: false,
          error: 'Centralization risk data not available'
        });
        return;
      }

      const risks = {
        centralizationRisk: topology.centralizationRisk,
        diversityScore: topology.diversityScore,
        providerRisks: topology.providerMetrics,
        riskFactors: {
          providerConcentration: Object.values(topology.providerMetrics)
            .reduce((max, metric) => Math.max(max, metric.riskScore), 0),
          geographicConcentration: topology.centralizationRisk,
          infrastructureDiversity: topology.diversityScore
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
      const topology = await this.enhancedDnsProcessor.analyzeNetworkTopology();
      
      if (!topology) {
        res.status(404).json({
          success: false,
          error: 'Provider distribution data not available'
        });
        return;
      }

      const providerStats = topology.providerMetrics;
      const totalValidators = Object.values(providerStats).reduce((sum, metric) => sum + metric.validatorCount, 0);
      
      const distribution = Object.entries(providerStats).map(([provider, metrics]) => ({
        provider,
        validatorCount: metrics.validatorCount,
        percentage: totalValidators > 0 ? (metrics.validatorCount / totalValidators) * 100 : 0,
        avgPerformance: metrics.avgPerformance,
        regions: metrics.regions,
        riskScore: metrics.riskScore
      }));

      res.json({
        success: true,
        data: {
          totalValidators,
          distribution: distribution.sort((a, b) => b.validatorCount - a.validatorCount),
          diversityIndex: topology.diversityScore,
          centralizationRisk: topology.centralizationRisk
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
      const topology = await this.enhancedDnsProcessor.analyzeNetworkTopology();
      
      if (!topology) {
        res.status(404).json({
          success: false,
          error: 'Geographic distribution data not available'
        });
        return;
      }

      const geoStats = topology.geographicDistribution;
      const totalValidators = Object.values(geoStats).reduce((sum, count) => sum + count, 0);
      
      const distribution = Object.entries(geoStats).map(([location, count]) => ({
        location,
        validatorCount: count,
        percentage: totalValidators > 0 ? (count / totalValidators) * 100 : 0
      }));

      res.json({
        success: true,
        data: {
          totalValidators,
          distribution: distribution.sort((a, b) => b.validatorCount - a.validatorCount),
          diversityIndex: topology.diversityScore
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
      const cacheStats = this.enhancedDnsProcessor.getCacheStats();
      
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
      await this.enhancedDnsProcessor.clearCache();
      
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

      const infrastructure = await this.enhancedDnsProcessor.getValidatorInfrastructure(validatorId);
      
      if (!infrastructure) {
        res.status(404).json({
          success: false,
          error: 'Validator infrastructure not found'
        });
        return;
      }

      res.json({
        success: true,
        data: infrastructure
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
      
      const results = await this.enhancedDnsProcessor.searchValidators({
        provider: provider as string,
        location: location as string,
        datacenter: datacenter as string
      });

      res.json({
        success: true,
        data: {
          totalFound: results.length,
          validators: results
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
      const cacheStats = this.enhancedDnsProcessor.getCacheStats();
      const isHealthy = cacheStats.totalEntries >= 0; // Basic health check
      
      res.json({
        success: true,
        status: isHealthy ? 'healthy' : 'degraded',
        data: {
          cacheEntries: cacheStats.totalEntries,
          cacheHitRate: cacheStats.hitRate,
          timestamp: new Date().toISOString()
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
} 