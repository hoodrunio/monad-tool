import { NodeRpcClient } from '../blockchain/NodeRpcClient';
import { logger } from '../../utils';

export interface EpochProgress {
  currentEpoch: number;
  currentBlock: number;
  epochStartBlock: number;
  epochEndBlock: number;
  blocksCompleted: number;
  blocksRemaining: number;
  progressPercentage: number;
  estimatedTimeToNextEpoch?: {
    hours: number;
    minutes: number;
    seconds: number;
  };
}

export interface EpochInfo {
  currentEpoch: number;
  previousEpoch: number;
  nextEpoch: number;
  epochInterval: number;
  currentBlock: number;
  progress: EpochProgress;
}

export class EpochService {
  private readonly epochInterval: number;
  private avgBlockTimeSeconds: number = 0.5; // Default 0.5 seconds per block for Monad

  constructor(private readonly rpcClient: NodeRpcClient, epochInterval: number = 50000) {
    this.epochInterval = epochInterval;
    if (epochInterval <= 0) {
      throw new Error('Epoch interval must be a positive number.');
    }
  }

  /**
   * Determines the current epoch by fetching the latest block number and dividing it
   * by the configured epoch interval.
   * @returns The calculated current epoch number.
   */
  async getCurrentEpoch(): Promise<number> {
    logger.info('Determining current epoch...');
    try {
      const latestBlockNumber = await this.rpcClient.getLatestBlockNumber();
      
      if (latestBlockNumber < 0) {
        throw new Error('Invalid block number received.');
      }

      const currentEpoch = Math.floor(latestBlockNumber / this.epochInterval);
      const epoch = Math.max(1, currentEpoch);
      const finalEpoch = epoch + 1;

      logger.info(`Calculated current epoch: ${finalEpoch} (from block ${latestBlockNumber})`);
      return finalEpoch;
    } catch (error) {
      logger.error('Failed to determine current epoch.', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Could not determine the current epoch.');
    }
  }

  /**
   * Calculate detailed epoch progress information
   */
  async getEpochProgress(): Promise<EpochProgress> {
    logger.info('Calculating epoch progress...');
    
    try {
      const currentBlock = await this.rpcClient.getLatestBlockNumber();
      
      if (currentBlock < 0) {
        throw new Error('Invalid block number received.');
      }

      const currentEpoch = Math.floor(currentBlock / this.epochInterval) + 1;
      const epochStartBlock = (currentEpoch - 1) * this.epochInterval;
      const epochEndBlock = currentEpoch * this.epochInterval - 1;
      
      const blocksCompleted = currentBlock - epochStartBlock;
      const blocksRemaining = epochEndBlock - currentBlock;
      const progressPercentage = (blocksCompleted / this.epochInterval) * 100;

      // Calculate estimated time to next epoch
      const estimatedTimeToNextEpoch = this.calculateEstimatedTime(blocksRemaining);

      const progress: EpochProgress = {
        currentEpoch,
        currentBlock,
        epochStartBlock,
        epochEndBlock,
        blocksCompleted: Math.max(0, blocksCompleted),
        blocksRemaining: Math.max(0, blocksRemaining),
        progressPercentage: Math.min(100, Math.max(0, progressPercentage)),
        estimatedTimeToNextEpoch
      };

      logger.info(`Epoch progress calculated: ${progress.progressPercentage.toFixed(2)}% complete`);
      return progress;
      
    } catch (error) {
      logger.error('Failed to calculate epoch progress.', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Could not calculate epoch progress.');
    }
  }

  /**
   * Get comprehensive epoch information
   */
  async getEpochInfo(): Promise<EpochInfo> {
    logger.info('Fetching comprehensive epoch information...');
    
    try {
      const progress = await this.getEpochProgress();
      
      const epochInfo: EpochInfo = {
        currentEpoch: progress.currentEpoch,
        previousEpoch: Math.max(1, progress.currentEpoch - 1),
        nextEpoch: progress.currentEpoch + 1,
        epochInterval: this.epochInterval,
        currentBlock: progress.currentBlock,
        progress
      };

      logger.info(`Epoch info retrieved: Current epoch ${epochInfo.currentEpoch}`);
      return epochInfo;
      
    } catch (error) {
      logger.error('Failed to get epoch information.', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Could not retrieve epoch information.');
    }
  }

  /**
   * Calculate which epoch a specific block belongs to
   */
  getEpochForBlock(blockNumber: number): number {
    if (blockNumber < 0) {
      throw new Error('Block number must be non-negative.');
    }
    
    return Math.floor(blockNumber / this.epochInterval) + 1;
  }

  /**
   * Get the start and end blocks for a specific epoch
   */
  getEpochBlockRange(epoch: number): { startBlock: number; endBlock: number } {
    if (epoch < 1) {
      throw new Error('Epoch must be greater than 0.');
    }
    
    const startBlock = (epoch - 1) * this.epochInterval;
    const endBlock = epoch * this.epochInterval - 1;
    
    return { startBlock, endBlock };
  }

  /**
   * Update the average block time for more accurate time estimations
   */
  setAverageBlockTime(seconds: number): void {
    if (seconds <= 0) {
      throw new Error('Average block time must be positive.');
    }
    
    this.avgBlockTimeSeconds = seconds;
    logger.info(`Average block time updated to ${seconds} seconds`);
  }

  /**
   * Get current epoch interval
   */
  getEpochInterval(): number {
    return this.epochInterval;
  }

  /**
   * Calculate estimated time for remaining blocks
   */
  private calculateEstimatedTime(blocksRemaining: number): {
    hours: number;
    minutes: number;
    seconds: number;
  } {
    const totalSeconds = blocksRemaining * this.avgBlockTimeSeconds;
    
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    
    return { hours, minutes, seconds };
  }
} 