import { NodeRpcClient } from '../blockchain/NodeRpcClient';
import { logger } from '../../utils';

export class EpochService {
  private readonly epochInterval: number;

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
} 