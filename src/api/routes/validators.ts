// Monad Validator Analytics - Validator Routes
import { Router } from 'express';
import { ValidatorController } from '../controllers/ValidatorController';

export function createValidatorRoutes(validatorController: ValidatorController): Router {
  const router = Router();

  // Staking integration endpoints
  router.get('/api/validators/staking/info', validatorController.getStakingInfo.bind(validatorController));
  router.post('/api/validators/staking/update', validatorController.forceStakingUpdate.bind(validatorController));

  // Validator ranking and statistics
  router.get('/api/validators/rankings', validatorController.getValidatorRankings.bind(validatorController));
  
  // Individual validator endpoints
  router.get('/api/validators/:id', validatorController.getValidatorDetails.bind(validatorController));
  router.get('/api/validators/:id/history', validatorController.getValidatorHistory.bind(validatorController));
  
  // Validator comparison endpoint
  router.post('/api/validators/compare', validatorController.compareValidators.bind(validatorController));

  return router;
} 