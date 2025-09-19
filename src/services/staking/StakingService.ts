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
      
      const consensusValidators = this.stakingInfo?.consensusValidators ?? new Set<string>();
      const executionValidators = this.stakingInfo?.executionValidators ?? new Set<string>();
      const allCurrentValidators = new Set<string>([...consensusValidators, ...executionValidators]);

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

          const isConsensus = consensusValidators.has(validatorId.toString());

          // Insert new validator
          await clickhouseClient.executeCommand(`
            INSERT INTO validator_registry (
              validator_id,
              node_id,
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
              '${secpAddress}',
              '${validatorId}',
              ${currentEpoch},
              ${validatorInfo.stake.toString()},
              ${isConsensus ? 1 : 0},
              ${isConsensus ? 1 : 0},
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

      // Get latest snapshot for all validators currently stored in the registry
      const latestRows = await clickhouseClient.executeRawQuery(`
        SELECT
          validator_id,
          node_id,
          precompile_validator_id,
          stake,
          position,
          dns_address,
          dns_host,
          dns_port,
          validator_name,
          keybase_id,
          keybase_logo_url,
          provider,
          location,
          country,
          datacenter,
          first_seen,
          is_active,
          is_staking_active,
          real_time_stake_wei
        FROM (
          SELECT
            validator_id,
            argMax(node_id, last_updated) AS node_id,
            argMax(precompile_validator_id, last_updated) AS precompile_validator_id,
            argMax(stake, last_updated) AS stake,
            argMax(position, last_updated) AS position,
            COALESCE(argMaxIf(dns_address, last_updated, dns_address != ''), argMax(dns_address, last_updated)) AS dns_address,
            COALESCE(argMaxIf(dns_host, last_updated, dns_host != ''), argMax(dns_host, last_updated)) AS dns_host,
            COALESCE(argMaxIf(dns_port, last_updated, dns_port != 0), argMax(dns_port, last_updated)) AS dns_port,
            COALESCE(argMaxIf(validator_name, last_updated, validator_name != '' AND validator_name != 'unknown'), argMax(validator_name, last_updated)) AS validator_name,
            COALESCE(argMaxIf(keybase_id, last_updated, keybase_id != ''), argMax(keybase_id, last_updated)) AS keybase_id,
            COALESCE(argMaxIf(keybase_logo_url, last_updated, keybase_logo_url != ''), argMax(keybase_logo_url, last_updated)) AS keybase_logo_url,
            COALESCE(argMaxIf(provider, last_updated, provider != '' AND provider != 'unknown'), argMax(provider, last_updated)) AS provider,
            COALESCE(argMaxIf(location, last_updated, location != '' AND location != 'unknown'), argMax(location, last_updated)) AS location,
            COALESCE(argMaxIf(country, last_updated, country != '' AND country != 'unknown'), argMax(country, last_updated)) AS country,
            COALESCE(argMaxIf(datacenter, last_updated, datacenter != '' AND datacenter != 'unknown'), argMax(datacenter, last_updated)) AS datacenter,
            argMax(first_seen, last_updated) AS first_seen,
            argMax(is_active, last_updated) AS is_active,
            argMax(is_staking_active, last_updated) AS is_staking_active,
            COALESCE(argMaxIf(real_time_stake_wei, last_updated, real_time_stake_wei != '' AND real_time_stake_wei != '0'), argMax(real_time_stake_wei, last_updated)) AS real_time_stake_wei
          FROM validator_registry
          GROUP BY validator_id
        ) latest
        WHERE precompile_validator_id != ''
      `);

      const latestRowMap = new Map<string, any>();
      latestRows.forEach((row: any) => {
        if (row.precompile_validator_id) {
          latestRowMap.set(row.precompile_validator_id, row);
        }
      });

      // Upsert current validator set with refreshed staking data
      const validatorRowsToInsert: any[] = [];
      const epochValue = Number(currentEpoch);

      if (this.stakingInfo) {
        for (const validatorId of allCurrentValidators) {
          const baseRow = latestRowMap.get(validatorId);
          if (!baseRow) {
            logger.warn(`No existing registry row found for validator ${validatorId} while updating stakes.`);
            continue;
          }

          const stake = this.stakingInfo.validatorStakes.get(validatorId) || BigInt(baseRow.stake || 0);
          const stakeString = stake.toString();
          const isConsensus = consensusValidators.has(validatorId);

          validatorRowsToInsert.push({
            validator_id: baseRow.validator_id,
            node_id: baseRow.node_id || baseRow.validator_id,
            epoch: epochValue,
            stake: stakeString,
            position: Number(baseRow.position || 0),
            is_active: isConsensus ? 1 : 0,
            dns_address: baseRow.dns_address || '',
            dns_host: baseRow.dns_host || '',
            dns_port: Number(baseRow.dns_port || 8000),
            validator_name: baseRow.validator_name || 'unknown',
            keybase_id: baseRow.keybase_id || '',
            keybase_logo_url: baseRow.keybase_logo_url || '',
            provider: baseRow.provider || 'unknown',
            location: baseRow.location || 'unknown',
            country: baseRow.country || 'unknown',
            datacenter: baseRow.datacenter || 'unknown',
            first_seen: this.formatDateTime(baseRow.first_seen) || this.formatDateTime(new Date()),
            last_updated: this.formatDateTime(new Date()),
            precompile_validator_id: validatorId,
            is_staking_active: isConsensus ? 1 : 0,
            real_time_stake_wei: stakeString
          });
        }

        // Mark validators that have left the consensus set as inactive
        latestRowMap.forEach((row, validatorId) => {
          if (allCurrentValidators.has(validatorId)) {
            return;
          }

          validatorRowsToInsert.push({
            validator_id: row.validator_id,
            node_id: row.node_id || row.validator_id,
            epoch: epochValue,
            stake: String(row.stake || 0),
            position: Number(row.position || 0),
            is_active: 0,
            dns_address: row.dns_address || '',
            dns_host: row.dns_host || '',
            dns_port: Number(row.dns_port || 8000),
            validator_name: row.validator_name || 'unknown',
            keybase_id: row.keybase_id || '',
            keybase_logo_url: row.keybase_logo_url || '',
            provider: row.provider || 'unknown',
            location: row.location || 'unknown',
            country: row.country || 'unknown',
            datacenter: row.datacenter || 'unknown',
            first_seen: this.formatDateTime(row.first_seen) || this.formatDateTime(new Date()),
            last_updated: this.formatDateTime(new Date()),
            precompile_validator_id: validatorId,
            is_staking_active: 0,
            real_time_stake_wei: String(row.real_time_stake_wei || row.stake || 0)
          });
        });

        if (validatorRowsToInsert.length > 0) {
          await clickhouseClient.insertRows('validator_registry', validatorRowsToInsert);
          logger.info(`✅ Updated staking snapshot for ${validatorRowsToInsert.length} validators`);
        }
      }

      logger.info(`✅ Incremental update complete: ${newValidators} new validators added`);
      
    } catch (error) {
      logger.error('Failed to update validators incrementally:', error);
      throw error;
    }
  }

  private formatDateTime(value: string | Date): string {
    if (value instanceof Date) {
      const normalized = value.toISOString().slice(0, 19).replace('T', ' ');
      return `${normalized}.000`;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      if (value.includes('T')) {
        const normalized = value.slice(0, 19).replace('T', ' ');
        return `${normalized}.000`;
      }

      return value.includes('.') ? value : `${value}.000`;
    }

    const date = new Date();
    const normalized = date.toISOString().slice(0, 19).replace('T', ' ');
    return `${normalized}.000`;
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
