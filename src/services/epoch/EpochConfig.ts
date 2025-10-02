/**
 * Configuration for Protocol-Accurate Epoch Tracking
 * 
 * Centralizes all configurable constants for epoch tracking:
 * - Delay period configuration
 * - ABT (Average Block Time) computation parameters
 * - Staleness detection thresholds
 */

export interface EpochTrackingConfig {
  // Delay period configuration
  delayPeriodRounds: number;
  
  // ABT computation parameters
  abtSampleSize: number;
  abtOutlierMethod: 'percentile' | 'iqr' | 'hardcap';
  abtPercentileLower: number;
  abtPercentileUpper: number;
  abtIqrMultiplier: number;
  abtHardcapMultiplier: number;
  abtRecomputeInterval: number; // blocks
  
  // Staleness detection
  stalenessThresholdSeconds: number;
  stalenessBlockLagThreshold: number;
  
  // RPC configuration
  stakingPrecompileAddress: string;
  rpcUrl: string;
  rpcTimeout: number;
}

export class EpochConfig {
  private static instance: EpochConfig;
  private config: EpochTrackingConfig;

  private constructor() {
    this.config = {
      // Delay period: 500 rounds after boundary before new validator set activates
      delayPeriodRounds: parseInt(process.env.EPOCH_DELAY_ROUNDS || '500'),
      
      // ABT computation: analyze last 10,000 blocks
      abtSampleSize: parseInt(process.env.ABT_SAMPLE_SIZE || '10000'),
      abtOutlierMethod: (process.env.ABT_OUTLIER_METHOD as any) || 'percentile',
      
      // Percentile trim: exclude outside P5-P95 (configurable)
      abtPercentileLower: parseFloat(process.env.ABT_PERCENTILE_LOWER || '5'),
      abtPercentileUpper: parseFloat(process.env.ABT_PERCENTILE_UPPER || '95'),
      
      // IQR filter: exclude outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
      abtIqrMultiplier: parseFloat(process.env.ABT_IQR_MULTIPLIER || '1.5'),
      
      // Hard cap: clamp intervals above 5x median
      abtHardcapMultiplier: parseFloat(process.env.ABT_HARDCAP_MULTIPLIER || '5'),
      
      // Recompute ABT every 1000 blocks (configurable)
      abtRecomputeInterval: parseInt(process.env.ABT_RECOMPUTE_INTERVAL || '1000'),
      
      // Staleness: consider stale if latest block is > 60 seconds old
      stalenessThresholdSeconds: parseInt(process.env.STALENESS_THRESHOLD_SECONDS || '60'),
      
      // Or if indexer is lagging by > 100 blocks
      stalenessBlockLagThreshold: parseInt(process.env.STALENESS_BLOCK_LAG || '100'),
      
      // Staking precompile
      stakingPrecompileAddress: process.env.STAKING_PRECOMPILE_ADDRESS || '0x0000000000000000000000000000000000001000',
      
      // RPC
      rpcUrl: process.env.RPC_URL || 'http://localhost:8080',
      rpcTimeout: parseInt(process.env.RPC_TIMEOUT || '10000'),
    };
  }

  static getInstance(): EpochConfig {
    if (!EpochConfig.instance) {
      EpochConfig.instance = new EpochConfig();
    }
    return EpochConfig.instance;
  }

  getConfig(): EpochTrackingConfig {
    return { ...this.config };
  }

  getDelayPeriodRounds(): number {
    return this.config.delayPeriodRounds;
  }

  getAbtSampleSize(): number {
    return this.config.abtSampleSize;
  }

  getAbtOutlierMethod(): 'percentile' | 'iqr' | 'hardcap' {
    return this.config.abtOutlierMethod;
  }

  getAbtPercentiles(): { lower: number; upper: number } {
    return {
      lower: this.config.abtPercentileLower,
      upper: this.config.abtPercentileUpper,
    };
  }

  getAbtIqrMultiplier(): number {
    return this.config.abtIqrMultiplier;
  }

  getAbtHardcapMultiplier(): number {
    return this.config.abtHardcapMultiplier;
  }

  getAbtRecomputeInterval(): number {
    return this.config.abtRecomputeInterval;
  }

  getStalenessThresholds(): { seconds: number; blockLag: number } {
    return {
      seconds: this.config.stalenessThresholdSeconds,
      blockLag: this.config.stalenessBlockLagThreshold,
    };
  }

  getStakingPrecompileAddress(): string {
    return this.config.stakingPrecompileAddress;
  }

  getRpcUrl(): string {
    return this.config.rpcUrl;
  }

  getRpcTimeout(): number {
    return this.config.rpcTimeout;
  }
}
