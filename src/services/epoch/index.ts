/**
 * Epoch Tracking Services
 * 
 * Protocol-accurate epoch tracking with:
 * - Staking precompile integration
 * - Robust ABT computation
 * - Staleness detection
 * - Delay period support
 */

export { EpochConfig } from './EpochConfig';
export { StakingPrecompileClient, PrecompileEpochData } from './StakingPrecompileClient';
export { AverageBlockTimeCalculator, AbtResult, BlockTimestamp } from './AverageBlockTimeCalculator';
export { StalenessDetector, StalenessInfo } from './StalenessDetector';
export { EnhancedEpochService } from './EnhancedEpochService';
export {
  EpochPhase,
  DelayConfig,
  EpochProgressInfo,
  EnhancedEpochInfo,
  RoundBlockInfo,
  EpochBoundary,
} from './types';

// Legacy service (kept for backward compatibility)
export { EpochService, EpochProgress, EpochInfo } from './EpochService';
