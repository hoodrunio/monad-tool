/**
 * Average Block Time (ABT) Calculator
 * 
 * Computes robust average block time from recent on-chain data with outlier handling.
 * Analyzes last N blocks from DB (timestamps from block_proposals table).
 * 
 * Supports three outlier handling methods:
 * 1. Percentile trim: exclude outside P5-P95 (default)
 * 2. IQR filter: exclude outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
 * 3. Hard cap: clamp intervals above 5x median
 */

import { ClickHouseClient } from '@clickhouse/client';
import { logger } from '../../utils';
import { EpochConfig } from './EpochConfig';

export interface AbtResult {
  averageBlockTimeSeconds: number;
  medianBlockTimeSeconds: number;
  sampleSize: number;
  effectiveSampleSize: number;
  outlierCount: number;
  outlierRate: number;
  method: 'percentile' | 'iqr' | 'hardcap';
  computedAt: Date;
}

export interface BlockTimestamp {
  seq_num: number;
  timestamp: Date;
}

export class AverageBlockTimeCalculator {
  private lastComputedBlock: number = 0;
  private cachedResult: AbtResult | null = null;

  constructor(
    private readonly clickhouse: ClickHouseClient,
    private readonly config = EpochConfig.getInstance()
  ) {}

  /**
   * Compute ABT from the last N blocks with outlier handling.
   * Uses caching: only recomputes if we've progressed enough blocks.
   * 
   * @param forceRecompute - Force recomputation even if cache is valid
   * @returns AbtResult with statistics
   */
  async computeAbt(forceRecompute: boolean = false): Promise<AbtResult> {
    try {
      // Get latest block number
      const latestBlock = await this.getLatestBlockNumber();
      
      // Check if we need to recompute
      const recomputeInterval = this.config.getAbtRecomputeInterval();
      if (!forceRecompute && this.cachedResult && latestBlock - this.lastComputedBlock < recomputeInterval) {
        logger.debug('Using cached ABT result', {
          lastComputedBlock: this.lastComputedBlock,
          currentBlock: latestBlock,
          cachedAbt: this.cachedResult.averageBlockTimeSeconds,
        });
        return this.cachedResult;
      }

      logger.info('Computing ABT from recent blocks', {
        latestBlock,
        sampleSize: this.config.getAbtSampleSize(),
      });

      // Fetch block timestamps
      const blockTimestamps = await this.fetchBlockTimestamps(latestBlock);
      
      if (blockTimestamps.length < 2) {
        throw new Error('Insufficient data: need at least 2 blocks for ABT computation');
      }

      // Compute inter-block intervals
      const intervals = this.computeIntervals(blockTimestamps);
      
      if (intervals.length === 0) {
        throw new Error('No valid intervals computed from block timestamps');
      }

      // Apply outlier handling based on configured method
      const method = this.config.getAbtOutlierMethod();
      const { filteredIntervals, outlierCount } = this.filterOutliers(intervals, method);
      
      if (filteredIntervals.length === 0) {
        throw new Error('All intervals were filtered as outliers');
      }

      // Compute statistics
      const averageBlockTimeSeconds = this.calculateMean(filteredIntervals);
      const medianBlockTimeSeconds = this.calculateMedian(filteredIntervals);
      const outlierRate = outlierCount / intervals.length;

      const result: AbtResult = {
        averageBlockTimeSeconds,
        medianBlockTimeSeconds,
        sampleSize: blockTimestamps.length,
        effectiveSampleSize: filteredIntervals.length,
        outlierCount,
        outlierRate,
        method,
        computedAt: new Date(),
      };

      // Cache the result
      this.cachedResult = result;
      this.lastComputedBlock = latestBlock;

      logger.info('ABT computed successfully', {
        abt: averageBlockTimeSeconds.toFixed(4),
        median: medianBlockTimeSeconds.toFixed(4),
        sampleSize: result.sampleSize,
        effectiveSampleSize: result.effectiveSampleSize,
        outlierRate: (outlierRate * 100).toFixed(2) + '%',
        method,
      });

      return result;
    } catch (error) {
      logger.error('Failed to compute ABT', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get the latest block number from the database
   */
  private async getLatestBlockNumber(): Promise<number> {
    const query = 'SELECT max(seq_num) as latest FROM monad_analytics.block_proposals';
    
    const result = await this.clickhouse.query({
      query,
      format: 'JSONEachRow',
    });

    const rows = await result.json() as Array<{ latest: string }>;
    
    if (rows.length === 0 || !rows[0].latest) {
      throw new Error('No blocks found in database');
    }

    return parseInt(rows[0].latest);
  }

  /**
   * Fetch block timestamps for ABT computation
   */
  private async fetchBlockTimestamps(latestBlock: number): Promise<BlockTimestamp[]> {
    const sampleSize = this.config.getAbtSampleSize();
    const startBlock = Math.max(0, latestBlock - sampleSize);

    const query = `
      SELECT 
        seq_num,
        timestamp
      FROM monad_analytics.block_proposals
      WHERE seq_num >= ${startBlock} AND seq_num <= ${latestBlock}
      ORDER BY seq_num ASC
    `;

    const result = await this.clickhouse.query({
      query,
      format: 'JSONEachRow',
    });

    const rows = await result.json() as Array<{ seq_num: string; timestamp: string }>;
    
    return rows.map(row => ({
      seq_num: parseInt(row.seq_num),
      timestamp: new Date(row.timestamp),
    }));
  }

  /**
   * Compute inter-block intervals (time differences between consecutive blocks)
   */
  private computeIntervals(blocks: BlockTimestamp[]): number[] {
    const intervals: number[] = [];
    
    for (let i = 1; i < blocks.length; i++) {
      const timeDiff = blocks[i].timestamp.getTime() - blocks[i - 1].timestamp.getTime();
      const intervalSeconds = timeDiff / 1000;
      
      // Only include positive intervals
      if (intervalSeconds > 0) {
        intervals.push(intervalSeconds);
      }
    }
    
    return intervals;
  }

  /**
   * Filter outliers using the configured method
   */
  private filterOutliers(
    intervals: number[],
    method: 'percentile' | 'iqr' | 'hardcap'
  ): { filteredIntervals: number[]; outlierCount: number } {
    switch (method) {
      case 'percentile':
        return this.filterByPercentile(intervals);
      case 'iqr':
        return this.filterByIqr(intervals);
      case 'hardcap':
        return this.filterByHardcap(intervals);
      default:
        return { filteredIntervals: intervals, outlierCount: 0 };
    }
  }

  /**
   * Percentile trim: exclude intervals outside P5-P95 (configurable)
   */
  private filterByPercentile(intervals: number[]): { filteredIntervals: number[]; outlierCount: number } {
    const sorted = [...intervals].sort((a, b) => a - b);
    const { lower, upper } = this.config.getAbtPercentiles();
    
    const lowerIndex = Math.floor(sorted.length * (lower / 100));
    const upperIndex = Math.ceil(sorted.length * (upper / 100)) - 1;
    
    const lowerBound = sorted[lowerIndex];
    const upperBound = sorted[upperIndex];
    
    const filtered = intervals.filter(v => v >= lowerBound && v <= upperBound);
    
    return {
      filteredIntervals: filtered,
      outlierCount: intervals.length - filtered.length,
    };
  }

  /**
   * IQR filter: exclude intervals outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
   */
  private filterByIqr(intervals: number[]): { filteredIntervals: number[]; outlierCount: number } {
    const sorted = [...intervals].sort((a, b) => a - b);
    const multiplier = this.config.getAbtIqrMultiplier();
    
    const q1Index = Math.floor(sorted.length * 0.25);
    const q3Index = Math.floor(sorted.length * 0.75);
    
    const q1 = sorted[q1Index];
    const q3 = sorted[q3Index];
    const iqr = q3 - q1;
    
    const lowerBound = q1 - multiplier * iqr;
    const upperBound = q3 + multiplier * iqr;
    
    const filtered = intervals.filter(v => v >= lowerBound && v <= upperBound);
    
    return {
      filteredIntervals: filtered,
      outlierCount: intervals.length - filtered.length,
    };
  }

  /**
   * Hard cap: clamp intervals above 5x median (configurable)
   */
  private filterByHardcap(intervals: number[]): { filteredIntervals: number[]; outlierCount: number } {
    const median = this.calculateMedian(intervals);
    const multiplier = this.config.getAbtHardcapMultiplier();
    const cap = median * multiplier;
    
    let outlierCount = 0;
    const capped = intervals.map(v => {
      if (v > cap) {
        outlierCount++;
        return cap;
      }
      return v;
    });
    
    return {
      filteredIntervals: capped,
      outlierCount,
    };
  }

  /**
   * Calculate mean of an array
   */
  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, val) => acc + val, 0);
    return sum / values.length;
  }

  /**
   * Calculate median of an array
   */
  private calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  /**
   * Clear the cached result
   */
  clearCache(): void {
    this.cachedResult = null;
    this.lastComputedBlock = 0;
    logger.debug('ABT cache cleared');
  }

  /**
   * Get cached result if available
   */
  getCachedResult(): AbtResult | null {
    return this.cachedResult;
  }
}
