import { ethers } from 'ethers';
import { logger } from '../../utils/logger';

// Staking precompile address
const STAKING_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000001000';

// Function selectors from documentation
const FUNCTION_SELECTORS = {
  getValidator: '0x2b6d639a',
  getConsensusValidatorSet: '0xfb29b729',
  getExecutionValidatorSet: '0x7cb074df',
  getEpoch: '0x757991a8'
};

export interface StakingValidator {
  validatorId: string;
  authAddress: string;
  flags: bigint;
  stake: bigint;
  accRewardPerToken: bigint;
  commission: bigint;
  unclaimedReward: bigint;
  consensusStake: bigint;
  consensusCommission: bigint;
  snapshotStake: bigint;
  snapshotCommission: bigint;
  secpPubkey: string;
  blsPubkey: string;
}

export interface ValidatorSetResult {
  done: boolean;
  nextIndex: number;
  validatorIds: bigint[];
}

export interface StakingInfo {
  currentEpoch: bigint;
  activeValidators: Set<string>;
  consensusValidators: Set<string>;
  executionValidators: Set<string>;
  validatorStakes: Map<string, bigint>;
  lastUpdated: Date;
}

/**
 * StakingService
 */
export class StakingService {
  private provider: ethers.JsonRpcProvider;
  private stakingInfo: StakingInfo | null = null;
  private isInitialized = false;

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('🔧 Initializing Staking Service...');
      
      // Test connection
      await this.provider.getBlockNumber();
      
      // Load initial staking info
      await this.refreshStakingInfo();
      
      this.isInitialized = true;
      logger.info('✅ Staking Service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize StakingService:', error);
      throw error;
    }
  }

  /**
   * Refresh all staking information from precompile
   */
  async refreshStakingInfo(): Promise<void> {
    try {
      logger.info('🔄 Refreshing staking information...');
      
      const currentEpoch = await this.getCurrentEpoch();
      logger.info(`Current epoch: ${currentEpoch}`);

      // Get all validator sets
      const [consensusValidators, executionValidators] = await Promise.all([
        this.getAllValidatorsFromSet('consensus'),
        this.getAllValidatorsFromSet('execution')
      ]);

      // Get detailed info for all unique validators
      const allValidatorIds = new Set([...consensusValidators, ...executionValidators]);
      const validatorStakes = new Map<string, bigint>();

      // Batch get validator details
      for (const validatorId of allValidatorIds) {
        try {
          const validatorInfo = await this.getValidatorInfo(validatorId);
          if (validatorInfo) {
            validatorStakes.set(validatorId, validatorInfo.stake);
          }
        } catch (error) {
          logger.warn(`Failed to get info for validator ${validatorId}:`, error);
        }
      }

      // Update staking info
      this.stakingInfo = {
        currentEpoch,
        activeValidators: new Set([...allValidatorIds]),
        consensusValidators: new Set(consensusValidators),
        executionValidators: new Set(executionValidators),
        validatorStakes,
        lastUpdated: new Date()
      };

      logger.info(`✅ Staking info refreshed - Active validators: ${allValidatorIds.size}, Consensus: ${consensusValidators.length}, Execution: ${executionValidators.length}`);
    } catch (error) {
      logger.error('Failed to refresh staking info:', error);
      throw error;
    }
  }

  /**
   * Get current epoch from staking precompile
   */
  async getCurrentEpoch(): Promise<bigint> {
    const data = FUNCTION_SELECTORS.getEpoch;
    
    const result = await this.provider.call({
      to: STAKING_CONTRACT_ADDRESS,
      data
    });

    return BigInt(result);
  }

  /**
   * Get validator information by ID
   */
  async getValidatorInfo(validatorId: string): Promise<StakingValidator | null> {
    try {
      // Convert validator ID to uint64 and encode
      const validatorIdBigInt = BigInt(validatorId);
      const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(['uint64'], [validatorIdBigInt]);
      const data = FUNCTION_SELECTORS.getValidator + encodedParams.slice(2);

      const result = await this.provider.call({
        to: STAKING_CONTRACT_ADDRESS,
        data
      });

      if (result === '0x') {
        return null;
      }

      // Decode result according to getValidator return signature
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode([
        'address', // auth_address
        'uint256', // flags
        'uint256', // stake
        'uint256', // acc_reward_per_token
        'uint256', // commission
        'uint256', // unclaimed_reward
        'uint256', // consensus_stake
        'uint256', // consensus_commission
        'uint256', // snapshot_stake
        'uint256', // snapshot_commission
        'bytes',   // secp_pubkey
        'bytes'    // bls_pubkey
      ], result);

      return {
        validatorId,
        authAddress: decoded[0],
        flags: decoded[1],
        stake: decoded[2],
        accRewardPerToken: decoded[3],
        commission: decoded[4],
        unclaimedReward: decoded[5],
        consensusStake: decoded[6],
        consensusCommission: decoded[7],
        snapshotStake: decoded[8],
        snapshotCommission: decoded[9],
        secpPubkey: decoded[10],
        blsPubkey: decoded[11]
      };
    } catch (error) {
      logger.warn(`Failed to get validator info for ${validatorId}:`, error);
      return null;
    }
  }

  /**
   * Get all validators from a specific set (consensus, execution, or snapshot)
   */
  private async getAllValidatorsFromSet(setType: 'consensus' | 'execution' | 'snapshot'): Promise<string[]> {
    const allValidators: string[] = [];
    let startIndex = 0;
    let done = false;

    const selector = setType === 'consensus' ? 
      FUNCTION_SELECTORS.getConsensusValidatorSet :
      FUNCTION_SELECTORS.getExecutionValidatorSet;

    while (!done) {
      try {
        const result = await this.getValidatorSet(selector, startIndex);
        
        // Convert BigInt validator IDs to strings
        const validatorIds = result.validatorIds.map(id => id.toString());
        allValidators.push(...validatorIds);
        
        done = result.done;
        startIndex = result.nextIndex;
        
        // Safety check to prevent infinite loops
        if (startIndex === 0 && !done) {
          logger.warn(`Potential infinite loop detected for ${setType} validator set`);
          break;
        }
      } catch (error) {
        logger.error(`Failed to get ${setType} validator set at index ${startIndex}:`, error);
        break;
      }
    }

    return allValidators;
  }

  /**
   * Get validator set page from precompile
   */
  private async getValidatorSet(selector: string, startIndex: number): Promise<ValidatorSetResult> {
    const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(['uint32'], [startIndex]);
    const data = selector + encodedParams.slice(2);

    const result = await this.provider.call({
      to: STAKING_CONTRACT_ADDRESS,
      data
    });

    // Decode result: (bool done, uint32 next_index, uint64[] valids)
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode([
      'bool',
      'uint32', 
      'uint64[]'
    ], result);

    return {
      done: decoded[0],
      nextIndex: decoded[1],
      validatorIds: decoded[2]
    };
  }

  /**
   * Check if validator is active (in any validator set)
   */
  isValidatorActive(validatorId: string): boolean {
    return this.stakingInfo?.activeValidators.has(validatorId) ?? false;
  }

  /**
   * Check if validator is in consensus set
   */
  isValidatorInConsensus(validatorId: string): boolean {
    return this.stakingInfo?.consensusValidators.has(validatorId) ?? false;
  }

  /**
   * Check if validator is in execution set
   */
  isValidatorInExecution(validatorId: string): boolean {
    return this.stakingInfo?.executionValidators.has(validatorId) ?? false;
  }

  /**
   * Get validator stake amount
   */
  getValidatorStake(validatorId: string): bigint | null {
    return this.stakingInfo?.validatorStakes.get(validatorId) ?? null;
  }

  /**
   * Get current staking info
   */
  getStakingInfo(): StakingInfo | null {
    return this.stakingInfo;
  }

  /**
   * Check if epoch has changed since last update
   */
  async hasEpochChanged(): Promise<boolean> {
    if (!this.stakingInfo) {
      return true; // Force update if no info
    }

    try {
      const currentEpoch = await this.getCurrentEpoch();
      return currentEpoch !== this.stakingInfo.currentEpoch;
    } catch (error) {
      logger.error('Failed to check epoch change:', error);
      return false;
    }
  }

  /**
   * Get all active validator IDs
   */
  getActiveValidatorIds(): string[] {
    return this.stakingInfo ? Array.from(this.stakingInfo.activeValidators) : [];
  }

  /**
   * Get statistics about current staking state
   */
  getStakingStats(): {
    totalActiveValidators: number;
    consensusValidators: number;
    executionValidators: number;
    totalStake: bigint;
    averageStake: bigint;
    currentEpoch: bigint;
    lastUpdated: Date;
  } | null {
    if (!this.stakingInfo) {
      return null;
    }

    const stakes = Array.from(this.stakingInfo.validatorStakes.values());
    const totalStake = stakes.reduce((sum, stake) => sum + stake, BigInt(0));
    const averageStake = stakes.length > 0 ? totalStake / BigInt(stakes.length) : BigInt(0);

    return {
      totalActiveValidators: this.stakingInfo.activeValidators.size,
      consensusValidators: this.stakingInfo.consensusValidators.size,
      executionValidators: this.stakingInfo.executionValidators.size,
      totalStake,
      averageStake,
      currentEpoch: this.stakingInfo.currentEpoch,
      lastUpdated: this.stakingInfo.lastUpdated
    };
  }
}
