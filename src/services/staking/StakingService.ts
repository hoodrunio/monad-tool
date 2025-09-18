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
  private lastUpdate: Date = new Date(0);
  private updateInterval: number;

  private isInitialized = false;

  constructor(rpcUrl: string, updateInterval: number = 30000) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.updateInterval = updateInterval;
    logger.info(`🔗 StakingService initialized with RPC: ${rpcUrl}`);
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

    // According to documentation: getEpoch() returns uint64
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint64'], result);
    return BigInt(decoded[0]);
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

  // =============================================
  // DATABASE-FIRST METHODS
  // =============================================

  /**
   * COMPREHENSIVE INITIAL POPULATION - Scan all validators and populate database
   * This should run only during startup
   */
  async populateAllValidatorsToDatabase(clickhouseClient: any): Promise<void> {
    logger.info('🔄 Starting comprehensive validator population to database...');
    
    try {
      let totalPopulated = 0;
      let consecutiveEmpty = 0;
      const MAX_CONSECUTIVE_EMPTY = 5;
      const MAX_VALIDATOR_ID = 1000;

      // Get current epoch for records
      const currentEpoch = await this.getCurrentEpoch();
      
      for (let validatorId = 1; validatorId <= MAX_VALIDATOR_ID; validatorId++) {
        try {
          const validatorInfo = await this.getValidatorInfo(validatorId.toString());
          
          if (!validatorInfo || !validatorInfo.stake || validatorInfo.stake === BigInt(0)) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
              logger.info(`🏁 Reached end of validators at ID ${validatorId} (${MAX_CONSECUTIVE_EMPTY} consecutive empty)`);
              break;
            }
            continue;
          }

          // Reset consecutive empty counter
          consecutiveEmpty = 0;
          
          // Get secp address
          const secpAddress = validatorInfo.secpPubkey?.startsWith('0x') 
            ? validatorInfo.secpPubkey.slice(2) 
            : validatorInfo.secpPubkey;

          if (!secpAddress) {
            logger.warn(`No secp address for validator ${validatorId}`);
            continue;
          }

          // Check if validator is currently active
          const isActive = this.stakingInfo?.activeValidators.has(validatorId.toString()) || false;

          // Insert into database with new staking columns
          await clickhouseClient.executeCommand(`
            INSERT INTO validator_registry (
              validator_id,
              precompile_validator_id,
              epoch,
              stake,
              is_active,
              is_staking_active,
              real_time_stake_wei,
              validator_name,
              provider,
              location,
              first_seen,
              last_updated
            ) VALUES (
              '${secpAddress}',
              '${validatorId}',
              ${currentEpoch},
              ${validatorInfo.stake.toString()},
              ${isActive ? 1 : 0},
              ${isActive ? 1 : 0},
              '${validatorInfo.stake.toString()}',
              'unknown',
              'unknown',
              'unknown',
              now(),
              now()
            )
          `);

          totalPopulated++;
          
          if (validatorId % 10 === 0) {
            logger.info(`📊 Populated ${totalPopulated} validators (current ID: ${validatorId})`);
          }

        } catch (error) {
          logger.warn(`Failed to populate validator ${validatorId}:`, error);
          // Continue with next validator
        }
      }

      logger.info(`✅ Initial population complete: ${totalPopulated} validators populated to database`);
      
    } catch (error) {
      logger.error('Failed to populate validators to database:', error);
      throw error;
    }
  }

  /**
   * INCREMENTAL UPDATE - Update database with new/changed validators since last update
   */
  async updateValidatorsIncrementally(clickhouseClient: any): Promise<void> {
    logger.info('🔄 Starting incremental validator update...');
    
    try {
      // Get last precompile_validator_id from database
      const lastIdQuery = `
        SELECT max(toUInt32(precompile_validator_id)) as last_id
        FROM validator_registry
        WHERE precompile_validator_id != ''
      `;
      
      const result = await clickhouseClient.executeRawQuery(lastIdQuery);
      const lastId = result[0]?.last_id || 0;
      
      logger.info(`📍 Continuing from validator ID: ${lastId + 1}`);
      
      // Current epoch
      const currentEpoch = await this.getCurrentEpoch();
      let newValidators = 0;
      let consecutiveEmpty = 0;
      
      // Scan for new validators starting from last_id + 1
      for (let validatorId = lastId + 1; validatorId <= lastId + 100; validatorId++) {
        try {
          const validatorInfo = await this.getValidatorInfo(validatorId.toString());
          
          if (!validatorInfo || !validatorInfo.stake || validatorInfo.stake === BigInt(0)) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= 5) {
              break; // Stop scanning
            }
            continue;
          }

          consecutiveEmpty = 0;
          
          const secpAddress = validatorInfo.secpPubkey?.startsWith('0x') 
            ? validatorInfo.secpPubkey.slice(2) 
            : validatorInfo.secpPubkey;

          if (!secpAddress) continue;

          const isActive = this.stakingInfo?.activeValidators.has(validatorId.toString()) || false;

          // Insert new validator
          await clickhouseClient.executeCommand(`
            INSERT INTO validator_registry (
              validator_id,
              precompile_validator_id,
              epoch,
              stake,
              is_active,
              is_staking_active,
              real_time_stake_wei,
              validator_name,
              provider,
              location,
              first_seen,
              last_updated
            ) VALUES (
              '${secpAddress}',
              '${validatorId}',
              ${currentEpoch},
              ${validatorInfo.stake.toString()},
              ${isActive ? 1 : 0},
              ${isActive ? 1 : 0},
              '${validatorInfo.stake.toString()}',
              'unknown',
              'unknown', 
              'unknown',
              now(),
              now()
            )
          `);

          newValidators++;
          
        } catch (error) {
          logger.warn(`Failed to update validator ${validatorId}:`, error);
        }
      }

      // Update existing active validators' stakes
      if (this.stakingInfo?.activeValidators) {
        let updatedStakes = 0;
        
        for (const activeValidatorId of this.stakingInfo.activeValidators) {
          const stake = this.stakingInfo.validatorStakes.get(activeValidatorId);
          if (stake) {
            await clickhouseClient.executeCommand(`
              INSERT INTO validator_registry (
                validator_id,
                precompile_validator_id,
                epoch,
                stake,
                is_active,
                is_staking_active,
                real_time_stake_wei,
                last_updated
              )
              SELECT 
                validator_id,
                precompile_validator_id,
                ${currentEpoch} as epoch,
                ${stake.toString()} as stake,
                1 as is_active,
                1 as is_staking_active,
                '${stake.toString()}' as real_time_stake_wei,
                now() as last_updated
              FROM validator_registry
              WHERE precompile_validator_id = '${activeValidatorId}'
              ORDER BY last_updated DESC
              LIMIT 1
            `);
            updatedStakes++;
          }
        }

        logger.info(`✅ Updated stakes for ${updatedStakes} active validators`);
      }

      logger.info(`✅ Incremental update complete: ${newValidators} new validators added`);
      
    } catch (error) {
      logger.error('Failed to update validators incrementally:', error);
      throw error;
    }
  }

  /**
   * DATABASE-FIRST: Get validator mappings from database (no precompile calls)
   */
  async getValidatorMappingBySecpAddress(clickhouseClient: any): Promise<Map<string, {validatorId: string, stake: bigint, isActive: boolean}>> {
    logger.info('🗄️ Getting validator mappings from database...');
    
    try {
      const query = `
        SELECT 
          validator_id as secp_address,
          precompile_validator_id as validator_id,
          real_time_stake_wei as stake,
          is_staking_active as is_active
        FROM (
          SELECT 
            validator_id,
            precompile_validator_id,
            real_time_stake_wei,
            is_staking_active,
            ROW_NUMBER() OVER (PARTITION BY validator_id ORDER BY last_updated DESC) as rn
          FROM validator_registry
          WHERE precompile_validator_id != ''
        )
        WHERE rn = 1
      `;
      
      const results = await clickhouseClient.executeRawQuery(query);
      const mapping = new Map<string, {validatorId: string, stake: bigint, isActive: boolean}>();
      
      for (const row of results) {
        if (row.secp_address && row.validator_id) {
          mapping.set(row.secp_address, {
            validatorId: row.validator_id,
            stake: BigInt(row.stake || '0'),
            isActive: Boolean(row.is_active)
          });
        }
      }
      
      logger.info(`✅ Retrieved ${mapping.size} validator mappings from database`);
      return mapping;
      
    } catch (error) {
      logger.error('Failed to get validator mappings from database:', error);
      return new Map();
    }
  }
}
