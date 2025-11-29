/**
 * Staking Precompile Client
 * 
 * Interfaces with the Monad staking precompile at 0x1000 to fetch canonical epoch state.
 * Primary method: getEpoch() returns (epochId, inEpochDelayPeriod)
 */

import { ethers } from 'ethers';
import { logger } from '../../utils';
import { EpochConfig } from './EpochConfig';

export interface PrecompileEpochData {
  epoch: bigint;
  inEpochDelayPeriod: boolean;
}

export class StakingPrecompileClient {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private readonly precompileAddress: string;

  // ABI for getEpoch() function
  // function getEpoch() external returns (uint64 epoch, bool inEpochDelayPeriod);
  // Selector: 0x757991a8
  private readonly abi = [
    'function getEpoch() external view returns (uint64 epoch, bool inEpochDelayPeriod)',
  ];

  constructor(rpcUrl?: string, precompileAddress?: string) {
    const config = EpochConfig.getInstance();
    
    this.precompileAddress = precompileAddress || config.getStakingPrecompileAddress();
    const rpcEndpoint = rpcUrl || config.getRpcUrl();
    
    logger.info('Initializing StakingPrecompileClient', {
      rpcUrl: rpcEndpoint,
      precompileAddress: this.precompileAddress,
    });

    this.provider = new ethers.JsonRpcProvider(rpcEndpoint);
    this.contract = new ethers.Contract(
      this.precompileAddress,
      this.abi,
      this.provider
    );
  }

  /**
   * Fetches the canonical epoch state from the staking precompile.
   * This is the source of truth for epoch ID and delay period status.
   * 
   * @returns PrecompileEpochData with epoch and inEpochDelayPeriod
   * @throws Error if precompile call fails
   */
  async getEpoch(): Promise<PrecompileEpochData> {
    try {
      logger.debug('Calling staking precompile getEpoch()');
      
      const result = await this.contract.getEpoch();
      
      const epochData: PrecompileEpochData = {
        epoch: result.epoch,
        inEpochDelayPeriod: result.inEpochDelayPeriod,
      };

      logger.info('Successfully fetched epoch from precompile', {
        epoch: epochData.epoch.toString(),
        inDelayPeriod: epochData.inEpochDelayPeriod,
      });

      return epochData;
    } catch (error) {
      logger.error('Failed to call staking precompile getEpoch()', {
        error: error instanceof Error ? error.message : String(error),
        precompileAddress: this.precompileAddress,
      });
      
      throw new Error(`Staking precompile getEpoch() call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if the precompile is reachable and responding
   * 
   * @returns true if precompile is available, false otherwise
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.getEpoch();
      return true;
    } catch (error) {
      logger.warn('Staking precompile is not available', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get the precompile address being used
   */
  getPrecompileAddress(): string {
    return this.precompileAddress;
  }

  /**
   * Get the RPC provider being used
   */
  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }
}
