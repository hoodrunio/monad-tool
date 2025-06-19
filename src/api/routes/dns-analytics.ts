import { Router } from 'express';
import { DNSAnalyticsController } from '../controllers/DNSAnalyticsController';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';

export function createDNSAnalyticsRoutes(
  clickhouseClient: MonadClickHouseClient, 
  redisClient: MonadRedisClient
): Router {
  const router = Router();
  const dnsController = new DNSAnalyticsController(clickhouseClient, redisClient);

  // DNS Analysis Routes
  router.get('/analyze', (req, res) => dnsController.analyzeDNSAddress(req, res));
  router.post('/batch-analyze', (req, res) => dnsController.batchAnalyzeDNS(req, res));

  // Network Topology Routes
  router.get('/network-topology', (req, res) => dnsController.getNetworkTopology(req, res));
  router.get('/centralization-risks', (req, res) => dnsController.getCentralizationRisks(req, res));

  // Distribution Statistics Routes
  router.get('/provider-distribution', (req, res) => dnsController.getProviderDistribution(req, res));
  router.get('/geographic-distribution', (req, res) => dnsController.getGeographicDistribution(req, res));

  // Validator Infrastructure Routes
  router.get('/validator-infrastructure/:validatorId', (req, res) => dnsController.getValidatorInfrastructure(req, res));
  router.get('/search', (req, res) => dnsController.searchValidators(req, res));

  // Cache Management Routes
  router.get('/cache-stats', (req, res) => dnsController.getDNSCacheStats(req, res));
  router.post('/clear-cache', (req, res) => dnsController.clearDNSCache(req, res));

  // Health Check Route
  router.get('/health', (req, res) => dnsController.healthCheck(req, res));

  return router;
} 