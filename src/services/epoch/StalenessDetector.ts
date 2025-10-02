/**
 * Staleness Detector
 * 
 * Monitors indexer lag by comparing:
 * 1. Latest indexed block timestamp vs wall-clock time
 * 2. Latest indexed seq_num vs RPC chain head (if available)
 * 
 * Determines when to suppress progress calculations and switch to degraded state.
 */

import { ClickHouseClient } from '@clickhouse/client';
import { logger } from '../../utils';
import { EpochConfig } from './EpochConfig';
import { NodeRpcClient } from '../blockchain/NodeRpcClient';

export interface StalenessInfo {
  isStale: boolean;
  latestIndexedBlock: number;
  latestIndexedTimestamp: Date;
  ageSeconds: number;
  chainHeadBlock: number | null;
  blockLag: number | null;
  reason: string | null;
}

export class StalenessDetector {
  constructor(
    private readonly clickhouse: ClickHouseClient,
    private readonly rpcClient: NodeRpcClient | null,
    private readonly config = EpochConfig.getInstance()
  ) {}

  /**
   * Check if the indexer is stale
   * 
   * Returns staleness information including:
   * - Latest indexed block and timestamp
   * - Age of latest block
   * - Block lag vs chain head (if RPC available)
   * - Stale flag and reason
   */
  async checkStaleness(): Promise<StalenessInfo> {
    try {
      // Get latest indexed block
      const { latestBlock, latestTimestamp } = await this.getLatestIndexedBlock();
      
      // Calculate age
      const now = new Date();
      const ageSeconds = (now.getTime() - latestTimestamp.getTime()) / 1000;
      
      // Get thresholds
      const { seconds: ageThreshold, blockLag: blockLagThreshold } = this.config.getStalenessThresholds();
      
      // Initialize result
      const result: StalenessInfo = {
        isStale: false,
        latestIndexedBlock: latestBlock,
        latestIndexedTimestamp: latestTimestamp,
        ageSeconds,
        chainHeadBlock: null,
        blockLag: null,
        reason: null,
      };

      // Check age-based staleness
      if (ageSeconds > ageThreshold) {
        result.isStale = true;
        result.reason = `Latest indexed block is ${ageSeconds.toFixed(0)}s old (threshold: ${ageThreshold}s)`;
        
        logger.warn('Indexer is stale (age-based)', {
          latestBlock,
          ageSeconds: ageSeconds.toFixed(2),
          threshold: ageThreshold,
        });
        
        return result;
      }

      // Check block lag if RPC client available
      if (this.rpcClient) {
        try {
          const chainHead = await this.rpcClient.getLatestBlockNumber();
          result.chainHeadBlock = chainHead;
          result.blockLag = chainHead - latestBlock;
          
          if (result.blockLag > blockLagThreshold) {
            result.isStale = true;
            result.reason = `Indexer is ${result.blockLag} blocks behind chain head (threshold: ${blockLagThreshold})`;
            
            logger.warn('Indexer is stale (block lag)', {
              latestIndexedBlock: latestBlock,
              chainHead,
              blockLag: result.blockLag,
              threshold: blockLagThreshold,
            });
            
            return result;
          }
        } catch (error) {
          logger.warn('Failed to check block lag via RPC', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Continue - age-based check already passed
        }
      }

      // Not stale
      logger.debug('Indexer is fresh', {
        latestBlock,
        ageSeconds: ageSeconds.toFixed(2),
        blockLag: result.blockLag,
      });

      return result;
    } catch (error) {
      logger.error('Failed to check staleness', {
        error: error instanceof Error ? error.message : String(error),
      });
      
      // Return conservative stale result on error
      return {
        isStale: true,
        latestIndexedBlock: 0,
        latestIndexedTimestamp: new Date(0),
        ageSeconds: Infinity,
        chainHeadBlock: null,
        blockLag: null,
        reason: `Staleness check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Get the latest indexed block from the database
   */
  private async getLatestIndexedBlock(): Promise<{ latestBlock: number; latestTimestamp: Date }> {
    const query = `
      SELECT 
        max(seq_num) as latest_block,
        argMax(timestamp, seq_num) as latest_timestamp
      FROM monad_analytics.block_proposals
    `;

    const result = await this.clickhouse.query({
      query,
      format: 'JSONEachRow',
    });

    const rows = await result.json() as Array<{ latest_block: string; latest_timestamp: string }>;
    
    if (rows.length === 0 || !rows[0].latest_block) {
      throw new Error('No blocks found in database');
    }

    return {
      latestBlock: parseInt(rows[0].latest_block),
      latestTimestamp: new Date(rows[0].latest_timestamp),
    };
  }

  /**
   * Quick check: is the indexer stale?
   */
  async isStale(): Promise<boolean> {
    const info = await this.checkStaleness();
    return info.isStale;
  }
}
