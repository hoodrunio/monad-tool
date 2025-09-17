// Staking-aware Validator Routes
import { Router } from 'express';
import { StakingValidatorController } from '../controllers/StakingValidatorController';

export function createStakingValidatorRoutes(stakingValidatorController: StakingValidatorController): Router {
  const router = Router();

  // =============================================
  // V2 API ENDPOINTS (New staking-aware)
  // =============================================

  // Main validators endpoint with active/inactive classification
  router.get('/api/v2/validators', stakingValidatorController.getValidatorsV2.bind(stakingValidatorController));
  
  // Active validators only
  router.get('/api/v2/validators/active', stakingValidatorController.getActiveValidators.bind(stakingValidatorController));
  
  // Inactive validators only
  router.get('/api/v2/validators/inactive', stakingValidatorController.getInactiveValidators.bind(stakingValidatorController));
  
  // Enhanced validator details with staking information
  router.get('/api/v2/validators/:id', stakingValidatorController.getValidatorDetailsV2.bind(stakingValidatorController));
  
  // Staking statistics
  router.get('/api/v2/validators/stats', stakingValidatorController.getStakingStats.bind(stakingValidatorController));
  
  // Manual sync trigger
  router.post('/api/v2/validators/sync', stakingValidatorController.forceSyncValidators.bind(stakingValidatorController));

  // =============================================
  // BACKWARD COMPATIBILITY ENDPOINTS
  // =============================================

  // Enhanced version of existing rankings endpoint
  router.get('/api/validators/rankings/enhanced', stakingValidatorController.getValidatorRankingsCompatible.bind(stakingValidatorController));

  return router;
}
