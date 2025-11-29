// Consensus API Routes
// Routes for BFT consensus tracking endpoints

import { Router } from 'express';
import { ConsensusController } from '../controllers/ConsensusController';

export function createConsensusRouter(controller: ConsensusController): Router {
  const router = Router();

  // Latest round state
  router.get('/latest', controller.getLatestRound.bind(controller));

  // Latest round votes (signed validators)
  router.get('/latest/votes', controller.getLatestVotes.bind(controller));

  // Latest round missing validators
  router.get('/latest/missing', controller.getLatestMissing.bind(controller));

  // Consensus summary statistics
  router.get('/summary', controller.getSummary.bind(controller));

  // Historical rounds
  router.get('/history', controller.getHistory.bind(controller));

  // Quorum status (peak stake across all rounds)
  router.get('/quorum', controller.getQuorumStatus.bind(controller));

  return router;
}
