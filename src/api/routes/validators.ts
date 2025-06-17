// Monad Validator Analytics - Validator Routes
import { Router } from 'express';
import { ValidatorController } from '../controllers/ValidatorController';

export function createValidatorRoutes(validatorController: ValidatorController): Router {
  const router = Router();

  // Validator ranking and statistics
  router.get('/api/validators/rankings', validatorController.getValidatorRankings.bind(validatorController));
  
  // Individual validator endpoints
  router.get('/api/validators/:id', validatorController.getValidatorDetails.bind(validatorController));
  router.get('/api/validators/:id/history', validatorController.getValidatorHistory.bind(validatorController));
  router.get('/api/validators/:id/performance', validatorController.getValidatorPerformance.bind(validatorController));

  return router;
} 