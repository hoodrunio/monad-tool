/**
 * Enhanced Epoch Tracking Types
 * 
 * Protocol-accurate types for epoch tracking with delay periods,
 * robust ABT, and staleness detection.
 */

import { AbtResult } from './AverageBlockTimeCalculator';
import { StalenessInfo } from './StalenessDetector';

/**
 * Epoch phase: normal, delay, or stale
 */
export type EpochPhase = 'normal' | 'delay' | 'stale';

/**
 * Delay period configuration and current state
 */
export interface DelayConfig {
  configuredDelayRounds: number;
  elapsedDelayRounds: number | null;
  remainingDelayRounds: number | null;
  delayProgressPercentage: number | null;
}

/**
 * Progress information with phase and explanation
 */
export interface EpochProgressInfo {
  phase: EpochPhase;
  value: number | null; // 0-1, or null when suppressed
  percentage: number | null; // 0-100, or null when suppressed
  explanation: string;
  
  // Round-based progress details
  currentRound: number | null;
  epochStartRound: number | null;
  epochBoundaryRound: number | null;
  roundsCompleted: number | null;
  roundsToNextEpoch: number | null;
}

/**
 * Complete enhanced epoch information
 */
export interface EnhancedEpochInfo {
  // Canonical epoch from precompile
  epochId: number;
  inEpochDelayPeriod: boolean;
  
  // Progress information
  progress: EpochProgressInfo;
  
  // Delay configuration
  delayConfig: DelayConfig;
  
  // Average block time
  abt: AbtResult | null;
  
  // Staleness information
  staleness: StalenessInfo;
  
  // Metadata
  timestamp: Date;
  precompileAvailable: boolean;
}

/**
 * Round-based block information from DB
 */
export interface RoundBlockInfo {
  round: number;
  seq_num: number;
  timestamp: Date;
  epoch: number;
}

/**
 * Epoch boundary information
 */
export interface EpochBoundary {
  epochId: number;
  boundaryRound: number;
  delayStartRound: number;
  delayEndRound: number;
  nextEpochStartRound: number;
}
