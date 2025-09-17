// Monad Staking Precompile Integration Service
import { ethers } from 'ethers';
import { logger } from '../../utils/logger';

/**
 * Staking Precompile Constants
 */
export const STAKING_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000001000';
export const PAGINATED_RESULTS_SIZE = 100;

/**
 * Validator Set Types
 */
export enum ValidatorSetType {
  CONSENSUS = 'consensus',
  SNAPSHOT = 'snapshot', 
  EXECUTION = 'execution'
}

/**
 * Validator Status from Staking Precompile
 */
export interface StakingValidator {
  validatorId: string;
  authAddress: string;
  flags: number;
  stake: string;
  accRewardPerToken: string;
  commission: string;
  unclaimedReward: string;
  consensusStake: string;
  consensusCommission: string;
  snapshotStake: string;
  snapshotCommission: string;
  secpPubkey: string;
  blsPubkey: string;
  isActive: boolean;
  isInConsensusSet: boolean;
  isInSnapshotSet: boolean;
  isInExecutionSet: boolean;
}

/**
 * Epoch Information
 */
export interface EpochInfo {
  epoch: number;
  inEpochDelayPeriod: boolean;
}

/**
 * Staking Precompile Service
 * 
 * Integrates with Monad's staking precompile to:
 * - Query active/inactive validators
 * - Get validator set information
 * - Monitor epoch changes
 * - Provide real-time staking data
 */
export class StakingPrecompileService {
  private provider: ethers.JsonRpcProvider;
  private stakingContract: ethers.Contract;
  private currentEpoch: number = 0;
  private isInitialized = false;

  // Function selectors from the precompile documentation
  private readonly SELECTORS = {
    getValidator: '0x2b6d639a',
    getConsensusValidatorSet: '0xfb29b729',
    getSnapshotValidatorSet: '0xde66a368', 
    getExecutionValidatorSet: '0x7cb074df',
    getEpoch: '0x757991a8'
  };

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Minimal ABI for the staking precompile functions we need
    const stakingABI = [
      "function getValidator(uint64 val_id) external view returns (address auth_address, uint256 flags, uint256 stake, uint256 acc_reward_per_token, uint256 commission, uint256 unclaimed_reward, uint256 consensus_stake, uint256 consensus_commission, uint256 snapshot_stake, uint256 snapshot_commission, bytes memory secp_pubkey, bytes memory bls_pubkey)",
      "function getConsensusValidatorSet(uint32 start_index) external view returns (bool done, uint32 next_index, uint64[] memory valids)",
      "function getSnapshotValidatorSet(uint32 start_index) external view returns (bool done, uint32 next_index, uint64[] memory valids)",
      "function getExecutionValidatorSet(uint32 start_index) external view returns (bool done, uint32 next_index, uint64[] memory valids)",
      "function getEpoch() external view returns (uint64, bool)"
    ];

    this.stakingContract = new ethers.Contract(STAKING_CONTRACT_ADDRESS, stakingABI, this.provider);
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('🔧 Initializing StakingPrecompileService...');
      
      // Get current epoch
      const epochInfo = await this.getCurrentEpoch();
      this.currentEpoch = epochInfo.epoch;
      
      logger.info(`✅ StakingPrecompileService initialized - Current epoch: ${this.currentEpoch}`);
      this.isInitialized = true;
    } catch (error) {
      logger.error('Failed to initialize StakingPrecompileService:', error);
      throw error;
    }
  }

  /**
   * Get current epoch information
   */
  async getCurrentEpoch(): Promise<EpochInfo> {
    try {
      const [epoch, inEpochDelayPeriod] = await this.stakingContract.getEpoch();
      return {
        epoch: Number(epoch),
        inEpochDelayPeriod
      };
    } catch (error) {
      logger.error('Failed to get current epoch:', error);
      throw error;
    }
  }

  /**
   * Get validator details by ID
   */
  async getValidator(validatorId: string): Promise<StakingValidator | null> {
    try {
      const result = await this.stakingContract.getValidator(validatorId);
      
      return {
        validatorId,
        authAddress: result.auth_address,
        flags: Number(result.flags),
        stake: result.stake.toString(),
        accRewardPerToken: result.acc_reward_per_token.toString(),
        commission: result.commission.toString(),
        unclaimedReward: result.unclaimed_reward.toString(),
        consensusStake: result.consensus_stake.toString(),
        consensusCommission: result.consensus_commission.toString(),
        snapshotStake: result.snapshot_stake.toString(),
        snapshotCommission: result.snapshot_commission.toString(),
        secpPubkey: result.secp_pubkey,
        blsPubkey: result.bls_pubkey,
        isActive: this.isValidatorActive(Number(result.flags)),
        isInConsensusSet: Number(result.consensus_stake) > 0,
        isInSnapshotSet: Number(result.snapshot_stake) > 0,
        isInExecutionSet: Number(result.stake) > 0
      };
    } catch (error) {
      logger.error(`Failed to get validator ${validatorId}:`, error);
      return null;
    }
  }

  /**
   * Get validator set IDs with pagination
   */
  async getValidatorSet(setType: ValidatorSetType, startIndex: number = 0): Promise<{
    validatorIds: string[];
    hasMore: boolean;
    nextIndex: number;
  }> {
    try {
      let result;
      
      switch (setType) {
        case ValidatorSetType.CONSENSUS:
          result = await this.stakingContract.getConsensusValidatorSet(startIndex);
          break;
        case ValidatorSetType.SNAPSHOT:
          result = await this.stakingContract.getSnapshotValidatorSet(startIndex);
          break;
        case ValidatorSetType.EXECUTION:
          result = await this.stakingContract.getExecutionValidatorSet(startIndex);
          break;
        default:
          throw new Error(`Invalid validator set type: ${setType}`);
      }

      const [done, nextIndex, validatorIds] = result;
      
      return {
        validatorIds: validatorIds.map((id: any) => id.toString()),
        hasMore: !done,
        nextIndex: Number(nextIndex)
      };
    } catch (error) {
      logger.error(`Failed to get ${setType} validator set:`, error);
      throw error;
    }
  }

  /**
   * Get all validator IDs from a specific set
   */
  async getAllValidatorIds(setType: ValidatorSetType): Promise<string[]> {
    const allValidatorIds: string[] = [];
    let startIndex = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await this.getValidatorSet(setType, startIndex);
      allValidatorIds.push(...result.validatorIds);
      hasMore = result.hasMore;
      startIndex = result.nextIndex;
    }

    return allValidatorIds;
  }

  /**
   * Get active validators (consensus set)
   */
  async getActiveValidators(): Promise<StakingValidator[]> {
    try {
      const consensusValidatorIds = await this.getAllValidatorIds(ValidatorSetType.CONSENSUS);
      const validators: StakingValidator[] = [];

      // Get validator details in batches to avoid rate limiting
      const batchSize = 10;
      for (let i = 0; i < consensusValidatorIds.length; i += batchSize) {
        const batch = consensusValidatorIds.slice(i, i + batchSize);
        const batchPromises = batch.map(id => this.getValidator(id));
        const batchResults = await Promise.all(batchPromises);
        
        validators.push(...batchResults.filter(v => v !== null) as StakingValidator[]);
      }

      return validators.filter(v => v.isActive);
    } catch (error) {
      logger.error('Failed to get active validators:', error);
      throw error;
    }
  }

  /**
   * Get inactive validators (registered but not in consensus set)
   */
  async getInactiveValidators(): Promise<StakingValidator[]> {
    try {
      // Get all execution validators (all registered validators)
      const executionValidatorIds = await this.getAllValidatorIds(ValidatorSetType.EXECUTION);
      
      // Get consensus validators (active validators)
      const consensusValidatorIds = await this.getAllValidatorIds(ValidatorSetType.CONSENSUS);
      const consensusSet = new Set(consensusValidatorIds);

      // Find validators that are in execution but not in consensus
      const inactiveValidatorIds = executionValidatorIds.filter(id => !consensusSet.has(id));

      const inactiveValidators: StakingValidator[] = [];
      
      // Get validator details in batches
      const batchSize = 10;
      for (let i = 0; i < inactiveValidatorIds.length; i += batchSize) {
        const batch = inactiveValidatorIds.slice(i, i + batchSize);
        const batchPromises = batch.map(id => this.getValidator(id));
        const batchResults = await Promise.all(batchPromises);
        
        inactiveValidators.push(...batchResults.filter(v => v !== null) as StakingValidator[]);
      }

      return inactiveValidators;
    } catch (error) {
      logger.error('Failed to get inactive validators:', error);
      throw error;
    }
  }

  /**
   * Get all validators with their status
   */
  async getAllValidatorsWithStatus(): Promise<{
    active: StakingValidator[];
    inactive: StakingValidator[];
    total: number;
  }> {
    try {
      const [active, inactive] = await Promise.all([
        this.getActiveValidators(),
        this.getInactiveValidators()
      ]);

      return {
        active,
        inactive,
        total: active.length + inactive.length
      };
    } catch (error) {
      logger.error('Failed to get all validators with status:', error);
      throw error;
    }
  }

  /**
   * Check if validator is active based on flags
   * This is a simplified check - you may need to adjust based on actual flag meanings
   */
  private isValidatorActive(flags: number): boolean {
    // Based on the precompile documentation, we need to check validator flags
    // This is a placeholder - adjust according to actual flag definitions
    return flags === 0; // Assuming 0 means no issues (ValidatorFlagsOk)
  }

  /**
   * Monitor epoch changes
   */
  async monitorEpochChanges(callback: (epochInfo: EpochInfo) => void): Promise<void> {
    setInterval(async () => {
      try {
        const epochInfo = await this.getCurrentEpoch();
        if (epochInfo.epoch !== this.currentEpoch) {
          this.currentEpoch = epochInfo.epoch;
          logger.info(`📊 Epoch changed to: ${this.currentEpoch}`);
          callback(epochInfo);
        }
      } catch (error) {
        logger.error('Failed to monitor epoch changes:', error);
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Get validator statistics
   */
  async getValidatorStats(): Promise<{
    totalValidators: number;
    activeValidators: number;
    inactiveValidators: number;
    consensusSetSize: number;
    executionSetSize: number;
    snapshotSetSize: number;
    currentEpoch: number;
  }> {
    try {
      const [consensusIds, executionIds, snapshotIds, epochInfo] = await Promise.all([
        this.getAllValidatorIds(ValidatorSetType.CONSENSUS),
        this.getAllValidatorIds(ValidatorSetType.EXECUTION),
        this.getAllValidatorIds(ValidatorSetType.SNAPSHOT),
        this.getCurrentEpoch()
      ]);

      return {
        totalValidators: executionIds.length,
        activeValidators: consensusIds.length,
        inactiveValidators: executionIds.length - consensusIds.length,
        consensusSetSize: consensusIds.length,
        executionSetSize: executionIds.length,
        snapshotSetSize: snapshotIds.length,
        currentEpoch: epochInfo.epoch
      };
    } catch (error) {
      logger.error('Failed to get validator statistics:', error);
      throw error;
    }
  }
}
