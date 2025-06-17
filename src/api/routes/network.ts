// Monad Validator Analytics - Network Routes
import { Router } from 'express';
import { NetworkController } from '../controllers/NetworkController';

export function createNetworkRoutes(networkController: NetworkController): Router {
  const router = Router();

  // Network overview and statistics
  router.get('/api/network/summary', networkController.getNetworkSummary.bind(networkController));
  router.get('/api/network/metrics', networkController.getNetworkMetrics.bind(networkController));
  
  // Geographic and infrastructure analysis
  router.get('/api/geographic/distribution', networkController.getGeographicDistribution.bind(networkController));
  
  // Network health and performance
  router.get('/api/network/health-score', networkController.getNetworkHealthScore.bind(networkController));
  router.get('/api/network/consensus-efficiency', networkController.getConsensusEfficiency.bind(networkController));
  router.get('/api/network/throughput', networkController.getThroughputAnalysis.bind(networkController));

  return router;
} 