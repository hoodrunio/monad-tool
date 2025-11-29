// Staking Events API Routes

import { Router } from 'express';
import { StakingEventController } from '../controllers/StakingEventController';

export function createStakingEventsRouter(controller: StakingEventController): Router {
  const router = Router();

  // Event queries
  router.get('/events', controller.getStakingEvents.bind(controller));
  router.get('/delegations/history', controller.getDelegationHistory.bind(controller));
  router.get('/rewards', controller.getRewardEvents.bind(controller));
  router.get('/stats', controller.getStakingStats.bind(controller));

  // Validator-specific
  router.get('/validators/:id/delegations', controller.getValidatorDelegations.bind(controller));

  // Delegator-specific
  router.get('/delegators/:address/delegations', controller.getDelegatorDelegations.bind(controller));

  // Indexer status
  router.get('/indexer/status', controller.getIndexerStatus.bind(controller));

  return router;
}
