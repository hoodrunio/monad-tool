import { ethers } from 'ethers';
import { logger } from '../../utils/logger';

// Staking precompile address
const STAKING_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000001000';

// Function selectors from documentation
const FUNCTION_SELECTORS = {
  getValidator: '0x2b6d639a',
  getConsensusValidatorSet: '0xfb29b729',
  getExecutionValidatorSet: '0x7cb074df',
  getDelegators: '0xa0843a26',
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

export interface DelegatorsPageResult {
  validatorId: string;
  isDone: boolean;
  nextDelegator: string;
  delegators: string[];
}

export interface ValidatorDelegatorsResult {
  validatorId: string;
  delegators: string[];
  isDone: boolean;
  nextDelegator: string | null;
  pagesFetched: number;
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

  /**
   * Fetch delegators for a validator with pagination support
   */
  async getValidatorDelegators(
    validatorId: string,
    options: {
      startDelegator?: string;
      maxPages?: number;
      fetchAll?: boolean;
    } = {}
  ): Promise<ValidatorDelegatorsResult> {
    const { startDelegator, maxPages, fetchAll = false } = options;

    const validatorIdBigInt = BigInt(validatorId);
    const initialDelegator = this.normalizeAddress(startDelegator);
    const MAX_AUTO_PAGES = 1024;
    const pageLimit = fetchAll
      ? MAX_AUTO_PAGES
      : Math.min(Math.max(1, maxPages ?? 1), MAX_AUTO_PAGES);

    const allDelegators: string[] = [];
    const seenDelegators = new Set<string>();
    const visitedStarts = new Set<string>();

    let currentStart = initialDelegator;
    let isDone = false;
    let nextDelegator: string | null = null;
    let pagesFetched = 0;

    while (!isDone && pagesFetched < pageLimit) {
      const page = await this.getDelegatorsPage(validatorIdBigInt, currentStart);
      pagesFetched += 1;

      for (const delegator of page.delegators) {
        const key = delegator.toLowerCase();
        if (!seenDelegators.has(key)) {
          seenDelegators.add(key);
          allDelegators.push(delegator);
        }
      }

      isDone = page.isDone;
      const pageNext = page.nextDelegator;
      nextDelegator = pageNext;

      if (isDone) {
        nextDelegator = null;
        break;
      }

      const normalizedNext = this.normalizeAddress(pageNext);

      if (visitedStarts.has(normalizedNext.toLowerCase())) {
        logger.warn(`Detected pagination loop while fetching delegators for validator ${validatorId}`);
        nextDelegator = normalizedNext;
        break;
      }

      visitedStarts.add(currentStart.toLowerCase());
      currentStart = normalizedNext;
    }

    return {
      validatorId,
      delegators: allDelegators,
      isDone,
      nextDelegator,
      pagesFetched
    };
  }

  /**
   * Retrieve a single page of delegators for a validator
   */
  private async getDelegatorsPage(validatorId: bigint, startDelegator: string): Promise<DelegatorsPageResult> {
    try {
      const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint64', 'address'],
        [validatorId, startDelegator]
      );

      const data = FUNCTION_SELECTORS.getDelegators + encodedParams.slice(2);

      const result = await this.provider.call({
        to: STAKING_CONTRACT_ADDRESS,
        data
      });

      if (!result || result === '0x') {
        return {
          validatorId: validatorId.toString(),
          isDone: true,
          nextDelegator: ethers.ZeroAddress,
          delegators: []
        };
      }

      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['bool', 'address', 'address[]'],
        result
      );

      const isDone = Boolean(decoded[0]);
      const nextDelegator = this.normalizeAddress(decoded[1]);
      const delegators = (decoded[2] as string[]).map(addr => this.normalizeAddress(addr));

      return {
        validatorId: validatorId.toString(),
        isDone,
        nextDelegator,
        delegators
      };
    } catch (error) {
      logger.error(`Failed to fetch delegators for validator ${validatorId.toString()}:`, error);
      throw error;
    }
  }

  /**
   * Normalize an address string, defaulting to the zero address when empty
   */
  private normalizeAddress(address?: string | null): string {
    if (!address || address === '0' || address === '0x0') {
      return ethers.ZeroAddress;
    }

    try {
      return ethers.getAddress(address);
    } catch (error) {
      logger.error(`Invalid address provided: ${address}`);
      throw new Error(`Invalid address: ${address}`);
    }
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

          const authAddress = this.normalizeAuthAddress(validatorInfo.authAddress);

          const commissionString = this.normalizeBigIntLike(validatorInfo.commission);
          const consensusCommissionString = this.normalizeBigIntLike(validatorInfo.consensusCommission);
          const snapshotCommissionString = this.normalizeBigIntLike(validatorInfo.snapshotCommission);

          // Check if validator is currently active
          const isActive = this.stakingInfo?.activeValidators.has(validatorId.toString()) || false;

          const stakeString = this.normalizeBigIntLike(validatorInfo.stake);

          // Insert into database with new staking columns
          await clickhouseClient.executeCommand(`
            INSERT INTO validator_registry (
              validator_id,
              node_id,
              auth_address,
              precompile_validator_id,
              epoch,
              stake,
              is_active,
              is_staking_active,
              real_time_stake_wei,
              commission,
              consensus_commission,
              snapshot_commission,
              first_seen,
              last_updated
            ) VALUES (
              '${secpAddress}',
              '${secpAddress}',
              '${authAddress}',
              '${validatorId}',
              ${currentEpoch},
              ${stakeString},
              ${isActive ? 1 : 0},
              ${isActive ? 1 : 0},
              '${stakeString}',
              '${commissionString}',
              '${consensusCommissionString}',
              '${snapshotCommissionString}',
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
          const authAddress = this.normalizeAuthAddress(validatorInfo.authAddress);
          const stakeString = this.normalizeBigIntLike(validatorInfo.stake);
          const commissionString = this.normalizeBigIntLike(validatorInfo.commission);
          const consensusCommissionString = this.normalizeBigIntLike(validatorInfo.consensusCommission);
          const snapshotCommissionString = this.normalizeBigIntLike(validatorInfo.snapshotCommission);

          // Insert new validator
          await clickhouseClient.executeCommand(`
            INSERT INTO validator_registry (
              validator_id,
              node_id,
              auth_address,
              precompile_validator_id,
              epoch,
              stake,
              is_active,
              is_staking_active,
              real_time_stake_wei,
              commission,
              consensus_commission,
              snapshot_commission,
              first_seen,
              last_updated
            ) VALUES (
              '${secpAddress}',
              '${secpAddress}',
              '${authAddress}',
              '${validatorId}',
              ${currentEpoch},
              ${stakeString},
              ${isConsensus ? 1 : 0},
              ${isConsensus ? 1 : 0},
              '${stakeString}',
              '${commissionString}',
              '${consensusCommissionString}',
              '${snapshotCommissionString}',
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
          auth_address,
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
          real_time_stake_wei,
          commission,
          consensus_commission,
          snapshot_commission
        FROM (
          SELECT
            validator_id,
            argMax(node_id, last_updated) AS node_id,
            COALESCE(argMaxIf(auth_address, last_updated, auth_address != ''), argMax(auth_address, last_updated)) AS auth_address,
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
            COALESCE(argMaxIf(real_time_stake_wei, last_updated, real_time_stake_wei != '' AND real_time_stake_wei != '0'), argMax(real_time_stake_wei, last_updated)) AS real_time_stake_wei,
            COALESCE(argMaxIf(commission, last_updated, commission != '' AND commission != '0'), argMax(commission, last_updated)) AS commission,
            COALESCE(argMaxIf(consensus_commission, last_updated, consensus_commission != '' AND consensus_commission != '0'), argMax(consensus_commission, last_updated)) AS consensus_commission,
            COALESCE(argMaxIf(snapshot_commission, last_updated, snapshot_commission != '' AND snapshot_commission != '0'), argMax(snapshot_commission, last_updated)) AS snapshot_commission
          FROM validator_registry
          GROUP BY validator_id
        ) latest
        WHERE precompile_validator_id != ''
      `);

      const latestRowMap = new Map<string, any>();
      latestRows.forEach((row: any) => {
        if (!row) {
          return;
        }

        const rawKey = row.precompile_validator_id;
        const key = rawKey !== undefined && rawKey !== null ? String(rawKey).trim() : '';

        if (key.length > 0) {
          latestRowMap.set(key, row);
        }
      });

      // Upsert current validator set with refreshed staking data
      const validatorRowsToInsert: Record<string, any>[] = [];
      const epochValue = Number(currentEpoch);
      let timestampOffset = 0;

      const nextTimestampString = (): string => {
        const timestamp = new Date(Date.now() + timestampOffset++);
        return this.formatDateTime(timestamp);
      };

      const validatorIdsToProcess = new Set<string>();
      latestRowMap.forEach((_, key) => {
        if (key) {
          validatorIdsToProcess.add(key);
        }
      });
      for (const validatorId of allCurrentValidators) {
        validatorIdsToProcess.add(validatorId);
      }

      for (const validatorId of validatorIdsToProcess) {
        const isConsensus = consensusValidators.has(validatorId);
        const isActiveValidator = isConsensus;

        const baseRow = await this.getRegistryRowForValidator(
          validatorId,
          latestRowMap,
          clickhouseClient,
          epochValue,
          nextTimestampString,
          isConsensus,
          isActiveValidator
        );

        if (!baseRow) {
          logger.warn(`No existing registry row found for validator ${validatorId} while updating stakes.`);
          continue;
        }

        if (baseRow.__isPlaceholder) {
          newValidators++;
          delete baseRow.__isPlaceholder;
        }

        let stakeBigInt = this.stakingInfo?.validatorStakes.get(validatorId) ?? null;
        let validatorInfo: StakingValidator | null = null;

        // Always fetch validator info to ensure commission data is up to date
        // Commission rates can change via governance, so we need to fetch them on every update
        const needsValidatorInfo = true;

        if (needsValidatorInfo) {
          try {
            validatorInfo = await this.getValidatorInfo(validatorId);
            if (validatorInfo?.stake !== undefined && stakeBigInt === null) {
              stakeBigInt = validatorInfo.stake;
              if (this.stakingInfo) {
                this.stakingInfo.validatorStakes.set(validatorId, validatorInfo.stake);
              }
            }
          } catch (error) {
            logger.warn(`Failed to refresh staking info for validator ${validatorId}:`, error);
          }
        }

        const fallbackStakeSource = baseRow.real_time_stake_wei ?? baseRow.stake ?? '0';
        const stakeString = this.normalizeBigIntLike(stakeBigInt ?? fallbackStakeSource);
        const realTimeStakeString = this.normalizeBigIntLike(
          validatorInfo?.stake ?? stakeBigInt ?? baseRow.real_time_stake_wei ?? fallbackStakeSource
        );
        const commissionString = this.normalizeBigIntLike(
          validatorInfo?.commission ?? baseRow.commission ?? '0'
        );
        const consensusCommissionString = this.normalizeBigIntLike(
          validatorInfo?.consensusCommission ?? baseRow.consensus_commission ?? '0'
        );
        const snapshotCommissionString = this.normalizeBigIntLike(
          validatorInfo?.snapshotCommission ?? baseRow.snapshot_commission ?? '0'
        );
        const lastUpdated = nextTimestampString();
        const firstSeen = baseRow.first_seen
          ? this.formatDateTime(baseRow.first_seen)
          : lastUpdated;

        const resolvedAuthAddress = this.normalizeAuthAddress(
          validatorInfo?.authAddress ?? baseRow.auth_address ?? ''
        );

        const preservedMetadata = this.preserveValidatorMetadata(baseRow);

        validatorRowsToInsert.push({
          validator_id: baseRow.validator_id,
          node_id: baseRow.node_id || baseRow.validator_id,
          epoch: epochValue,
          stake: stakeString,
          position: Number(baseRow.position || 0),
          is_active: isActiveValidator ? 1 : 0,
          is_staking_active: isConsensus ? 1 : 0,
          real_time_stake_wei: realTimeStakeString,
          commission: commissionString,
          consensus_commission: consensusCommissionString,
          snapshot_commission: snapshotCommissionString,
          precompile_validator_id: validatorId,
          first_seen: firstSeen,
          last_updated: lastUpdated,
          ...preservedMetadata,
          auth_address: resolvedAuthAddress
        });

        baseRow.first_seen = firstSeen;
        baseRow.last_updated = lastUpdated;
        baseRow.is_active = isActiveValidator ? 1 : 0;
        baseRow.is_staking_active = isConsensus ? 1 : 0;
        baseRow.real_time_stake_wei = realTimeStakeString;
        baseRow.stake = stakeString;
        baseRow.commission = commissionString;
        baseRow.consensus_commission = consensusCommissionString;
        baseRow.snapshot_commission = snapshotCommissionString;
        baseRow.auth_address = resolvedAuthAddress;
        latestRowMap.set(validatorId, baseRow);
      }

      if (validatorRowsToInsert.length > 0) {
        await clickhouseClient.insertRows('validator_registry', validatorRowsToInsert);
        await clickhouseClient.rebuildValidatorRegistryLatest(
          validatorRowsToInsert.map(row => row.validator_id)
        );
        logger.info(`✅ Updated staking snapshot for ${validatorRowsToInsert.length} validators`);
      }

      logger.info(`✅ Incremental update complete: ${newValidators} new validators added`);
      
    } catch (error) {
      logger.error('Failed to update validators incrementally:', error);
      throw error;
    }
  }

  async backfillMissingPrecompileIds(clickhouseClient: any): Promise<void> {
    try {
      logger.info('🔍 Checking for validators missing precompile IDs...');

      const missingRows = await clickhouseClient.executeRawQuery(`
        WITH latest AS (
          SELECT
            validator_id,
            node_id,
            auth_address,
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
            last_updated,
            is_active,
            is_staking_active,
            real_time_stake_wei,
            commission,
            consensus_commission,
            snapshot_commission,
            epoch,
            ROW_NUMBER() OVER (PARTITION BY validator_id ORDER BY last_updated DESC) AS rn
          FROM validator_registry
        )
        SELECT
          validator_id,
          node_id,
          auth_address,
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
          last_updated,
          is_active,
          is_staking_active,
          real_time_stake_wei,
          commission,
          consensus_commission,
          snapshot_commission,
          epoch
        FROM latest
        WHERE rn = 1 AND (precompile_validator_id = '' OR precompile_validator_id IS NULL)
      `);

      if (!missingRows || missingRows.length === 0) {
        logger.info('✅ No validators require precompile backfill');
        return;
      }

      logger.warn(`⚠️ Detected ${missingRows.length} validators without precompile IDs. Attempting backfill...`);

      const targetSecpAddresses = new Set<string>();
      for (const row of missingRows) {
        const normalized = this.normalizeSecpAddress(row?.validator_id);
        if (normalized) {
          targetSecpAddresses.add(normalized);
        }
      }

      if (targetSecpAddresses.size === 0) {
        logger.warn('⚠️ Could not normalize any validator IDs for backfill');
        return;
      }

      const maxIdResult = await clickhouseClient.executeRawQuery(`
        SELECT max(toUInt32(precompile_validator_id)) AS max_id
        FROM validator_registry
        WHERE precompile_validator_id != ''
      `);

      const maxKnownId = Number(maxIdResult[0]?.max_id || 0);
      const activeMaxId = this.stakingInfo
        ? Math.max(0, ...Array.from(this.stakingInfo.validatorStakes.keys()).map(id => Number(id)).filter(n => !Number.isNaN(n)))
        : 0;
      const scanLimit = Math.max(maxKnownId, activeMaxId) + 200;

      if (scanLimit <= 0) {
        logger.warn('⚠️ Unable to determine precompile ID scan window; skipping backfill');
        return;
      }

      const secpToPrecompile = await this.buildPrecompileIdMapping(targetSecpAddresses, scanLimit);

      if (secpToPrecompile.size === 0) {
        logger.warn('⚠️ Failed to resolve any precompile IDs for missing validators');
        return;
      }

      const nowString = this.formatDateTime(new Date());
      const currentEpoch = Number(this.stakingInfo?.currentEpoch ?? 0);
      const rowsToInsert: Record<string, any>[] = [];

      for (const row of missingRows) {
        const normalized = this.normalizeSecpAddress(row?.validator_id);
        if (!normalized) {
          continue;
        }

        const precompileId = secpToPrecompile.get(normalized);
        if (!precompileId) {
          logger.warn(`⚠️ Unable to resolve precompile ID for validator ${row?.validator_id}`);
          continue;
        }

        let validatorInfo: StakingValidator | null = null;
        if (!row.auth_address) {
          try {
            validatorInfo = await this.getValidatorInfo(precompileId);
          } catch (error) {
            logger.warn(`Failed to fetch validator info for ${precompileId} during backfill:`, error);
          }
        }

        const stakeString = this.normalizeBigIntLike(row?.stake ?? row?.real_time_stake_wei ?? '0');
        const realTimeStakeString = this.normalizeBigIntLike(row?.real_time_stake_wei ?? stakeString);
        const resolvedAuthAddress = this.normalizeAuthAddress(
          validatorInfo?.authAddress ?? row.auth_address ?? ''
        );
        const preservedMetadata = this.preserveValidatorMetadata(row);
        const commissionString = this.normalizeBigIntLike(
          validatorInfo?.commission ?? row.commission ?? '0'
        );
        const consensusCommissionString = this.normalizeBigIntLike(
          validatorInfo?.consensusCommission ?? row.consensus_commission ?? '0'
        );
        const snapshotCommissionString = this.normalizeBigIntLike(
          validatorInfo?.snapshotCommission ?? row.snapshot_commission ?? '0'
        );

        rowsToInsert.push({
          validator_id: row.validator_id,
          node_id: row.node_id || row.validator_id,
          precompile_validator_id: precompileId,
          epoch: currentEpoch > 0 ? currentEpoch : Number(row.epoch || 0),
          stake: stakeString,
          position: Number(row.position || 0),
          is_active: Number(row.is_active || 0),
          is_staking_active: Number(row.is_staking_active || 0),
          real_time_stake_wei: realTimeStakeString,
          commission: commissionString,
          consensus_commission: consensusCommissionString,
          snapshot_commission: snapshotCommissionString,
          first_seen: this.formatDateTime(row.first_seen || nowString),
          last_updated: nowString,
          ...preservedMetadata,
          auth_address: resolvedAuthAddress
        });
      }

      if (rowsToInsert.length === 0) {
        logger.warn('⚠️ Backfill attempted but no rows were eligible for insertion');
        return;
      }

      await clickhouseClient.insertRows('validator_registry', rowsToInsert);
      await clickhouseClient.rebuildValidatorRegistryLatest(
        rowsToInsert.map(row => row.validator_id)
      );
      logger.info(`✅ Backfilled precompile IDs for ${rowsToInsert.length} validators`);
    } catch (error) {
      logger.error('Failed to backfill missing precompile IDs:', error);
    }
  }

  async synchronizeValidatorSnapshots(clickhouseClient: any): Promise<void> {
    try {
      // First, make sure no validator is missing a precompile ID
      await this.backfillMissingPrecompileIds(clickhouseClient);

      logger.info('🔁 Synchronizing validator stakes and activity state with staking precompile...');

      const latestRows = await clickhouseClient.executeRawQuery(`
        WITH latest AS (
          SELECT
            validator_id,
            node_id,
            auth_address,
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
            last_updated,
            is_active,
            is_staking_active,
            real_time_stake_wei,
            commission,
            consensus_commission,
            snapshot_commission,
            epoch,
            ROW_NUMBER() OVER (PARTITION BY validator_id ORDER BY last_updated DESC) AS rn
          FROM validator_registry
        )
        SELECT
          validator_id,
          node_id,
          auth_address,
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
          last_updated,
          is_active,
          is_staking_active,
          real_time_stake_wei,
          commission,
          consensus_commission,
          snapshot_commission,
          epoch
        FROM latest
        WHERE rn = 1
      `);

      if (!latestRows || latestRows.length === 0) {
        logger.info('✅ No validator snapshots found for synchronization');
        return;
      }

      const rowsToInsert: Record<string, any>[] = [];

      const missingSecp = new Set<string>();
      for (const row of latestRows) {
        if (!row?.precompile_validator_id) {
          const normalized = this.normalizeSecpAddress(row?.validator_id);
          if (normalized) {
            missingSecp.add(normalized);
          }
        }
      }

      let secpToPrecompile = new Map<string, string>();
      if (missingSecp.size > 0) {
        const maxKnownIdResult = await clickhouseClient.executeRawQuery(`
          SELECT max(toUInt32(precompile_validator_id)) AS max_id
          FROM validator_registry
          WHERE precompile_validator_id != ''
        `);
        const maxKnownId = Number(maxKnownIdResult[0]?.max_id || 0);
        const activeMaxId = this.stakingInfo
          ? Math.max(0, ...Array.from(this.stakingInfo.validatorStakes.keys()).map(id => Number(id)).filter(n => !Number.isNaN(n)))
          : 0;
        const scanLimit = Math.max(maxKnownId, activeMaxId) + 200;
        if (scanLimit > 0) {
          secpToPrecompile = await this.buildPrecompileIdMapping(missingSecp, scanLimit);
        }
      }

      const now = new Date();
      let timestampOffset = 0;
      const nextTimestamp = () => this.formatDateTime(new Date(now.getTime() + (timestampOffset++)));
      const epochValue = Number(this.stakingInfo?.currentEpoch ?? 0);

      for (const row of latestRows) {
        const normalizedSecp = this.normalizeSecpAddress(row.validator_id);
        let precompileId = row.precompile_validator_id;

        if ((!precompileId || precompileId.length === 0) && normalizedSecp) {
          precompileId = secpToPrecompile.get(normalizedSecp) || '';
        }

        if (!precompileId) {
          logger.warn(`⚠️ Unable to determine precompile ID during synchronization for validator ${row.validator_id}`);
          continue;
        }

        let stakeBigInt = this.stakingInfo?.validatorStakes.get(precompileId) ?? null;
        let validatorInfo: StakingValidator | null = null;

        const needsValidatorInfo = stakeBigInt === null || !row.auth_address;

        if (needsValidatorInfo) {
          try {
            validatorInfo = await this.getValidatorInfo(precompileId);
            if (validatorInfo && stakeBigInt === null) {
              stakeBigInt = validatorInfo.stake;
            }
          } catch (error) {
            logger.warn(`Failed to fetch validator info for ${precompileId}:`, error);
          }
        }

        const stakeString = this.normalizeBigIntLike(stakeBigInt ?? row.stake ?? '0');
        const realTimeStakeString = this.normalizeBigIntLike(
          validatorInfo?.stake ?? row.real_time_stake_wei ?? stakeString
        );
        const commissionString = this.normalizeBigIntLike(
          validatorInfo?.commission ?? row.commission ?? '0'
        );
        const consensusCommissionString = this.normalizeBigIntLike(
          validatorInfo?.consensusCommission ?? row.consensus_commission ?? '0'
        );
        const snapshotCommissionString = this.normalizeBigIntLike(
          validatorInfo?.snapshotCommission ?? row.snapshot_commission ?? '0'
        );

        const isConsensus = this.stakingInfo?.consensusValidators.has(precompileId) ?? false;

        const resolvedAuthAddress = this.normalizeAuthAddress(
          validatorInfo?.authAddress ?? row.auth_address ?? ''
        );

        const preservedMetadata = this.preserveValidatorMetadata(row);

        rowsToInsert.push({
          validator_id: row.validator_id,
          node_id: row.node_id || row.validator_id,
          precompile_validator_id: precompileId,
          epoch: epochValue > 0 ? epochValue : Number(row.epoch || 0),
          stake: stakeString,
          position: Number(row.position || 0),
          is_active: isConsensus ? 1 : 0,
          is_staking_active: isConsensus ? 1 : 0,
          real_time_stake_wei: realTimeStakeString,
          commission: commissionString,
          consensus_commission: consensusCommissionString,
          snapshot_commission: snapshotCommissionString,
          first_seen: this.formatDateTime(row.first_seen || now),
          last_updated: nextTimestamp(),
          ...preservedMetadata,
          auth_address: resolvedAuthAddress
        });
      }

      if (rowsToInsert.length === 0) {
        logger.info('✅ Validator registry already synchronized with staking data');
        return;
      }

      await clickhouseClient.insertRows('validator_registry', rowsToInsert);
      await clickhouseClient.rebuildValidatorRegistryLatest(
        rowsToInsert.map(row => row.validator_id)
      );
      logger.info(`✅ Synchronized ${rowsToInsert.length} validator snapshots with staking data`);
    } catch (error) {
      logger.error('Failed to synchronize validator registry snapshots:', error);
    }
  }

  private normalizeSecpAddress(value: any): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return null;
      }
      return trimmed.toLowerCase().replace(/^0x/, '');
    }

    if (value instanceof Uint8Array) {
      return ethers.hexlify(value).replace(/^0x/, '').toLowerCase();
    }

    return null;
  }

  private normalizeAuthAddress(value: any): string {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return '';
      }
      const lower = trimmed.toLowerCase();
      return lower.startsWith('0x') ? lower : `0x${lower}`;
    }

    if (value instanceof Uint8Array) {
      return ethers.hexlify(value).toLowerCase();
    }

    return '';
  }

  private async buildPrecompileIdMapping(targetSecpAddresses: Set<string>, scanLimit: number): Promise<Map<string, string>> {
    const mapping = new Map<string, string>();

    for (let validatorId = 1; validatorId <= scanLimit; validatorId++) {
      if (mapping.size === targetSecpAddresses.size) {
        break;
      }

      try {
        const validatorInfo = await this.getValidatorInfo(validatorId.toString());
        if (!validatorInfo || !validatorInfo.secpPubkey) {
          continue;
        }

        const normalizedSecp = this.normalizeSecpAddress(validatorInfo.secpPubkey);
        if (!normalizedSecp) {
          continue;
        }

        if (targetSecpAddresses.has(normalizedSecp) && !mapping.has(normalizedSecp)) {
          mapping.set(normalizedSecp, validatorId.toString());
        }
      } catch (error) {
        logger.debug(`Failed to fetch validator info for ID ${validatorId}:`, error);
      }
    }

    return mapping;
  }

  private normalizeBigIntLike(value: any): string {
    if (value === null || value === undefined) {
      return '0';
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return '0';
      }
      // Use toFixed(0) to prevent scientific notation for very large numbers
      return value.toFixed(0);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : '0';
    }

    return '0';
  }

  private formatDateTime(value: string | Date): string {
    const toClickHouse = (date: Date): string => {
      const iso = date.toISOString();
      return iso.replace('T', ' ').replace('Z', '');
    };

    if (value instanceof Date) {
      return toClickHouse(value);
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      const trimmed = value.trim();

      // Already in ClickHouse format; return as-is
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
        return trimmed;
      }

      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return toClickHouse(parsed);
      }
      return toClickHouse(new Date());
    }

    return toClickHouse(new Date());
  }

  /**
   * Preserve non-staking metadata fields from existing registry rows so staking updates
   * never clobber infrastructure information.
   */
  private preserveValidatorMetadata(baseRow: any): Record<string, any> {
    if (!baseRow) {
      return {};
    }

    const preserved: Record<string, any> = {};
    const stringFields = [
      'auth_address',
      'dns_address',
      'dns_host',
      'validator_name',
      'keybase_id',
      'keybase_logo_url',
      'provider',
      'location',
      'country',
      'datacenter'
    ];

    for (const field of stringFields) {
      const value = baseRow[field];
      if (typeof value !== 'string') {
        continue;
      }

      const trimmed = value.trim();
      if (!trimmed || trimmed.toLowerCase() === 'unknown') {
        continue;
      }

      preserved[field] = value;
    }

    if (baseRow.dns_port !== undefined && baseRow.dns_port !== null) {
      const port = Number(baseRow.dns_port);
      if (!Number.isNaN(port) && port > 0) {
        preserved.dns_port = port;
      }
    }

    return preserved;
  }

  private async getRegistryRowForValidator(
    validatorId: string,
    cache: Map<string, any>,
    clickhouseClient: any,
    epochValue: number,
    nextTimestampString: () => string,
    isConsensus: boolean,
    isActiveValidator: boolean
  ): Promise<any | null> {
    const cached = cache.get(validatorId);
    if (cached) {
      return cached;
    }

    // Try to fetch by precompile ID first
    const rowByPrecompile = await this.fetchLatestRegistryRow(
      clickhouseClient,
      `precompile_validator_id = '${validatorId}'`
    );
    if (rowByPrecompile) {
      if (!rowByPrecompile.auth_address) {
        try {
          const validatorInfo = await this.getValidatorInfo(validatorId);
          if (validatorInfo?.authAddress) {
            rowByPrecompile.auth_address = this.normalizeAuthAddress(validatorInfo.authAddress);
          }
        } catch (error) {
          logger.debug(`Failed to backfill auth address for validator ${validatorId}:`, error);
        }
      }
      cache.set(validatorId, rowByPrecompile);
      return rowByPrecompile;
    }

    // Fallback: derive secp address from precompile and look up by validator_id
    try {
      const validatorInfo = await this.getValidatorInfo(validatorId);
      if (!validatorInfo || !validatorInfo.secpPubkey) {
        return null;
      }

      const rawSecp = validatorInfo.secpPubkey as string | Uint8Array;
      const secpHex = typeof rawSecp === 'string'
        ? rawSecp
        : ethers.hexlify(rawSecp);

      const secpAddress = secpHex.startsWith('0x')
        ? secpHex.slice(2)
        : secpHex;

      if (!secpAddress || secpAddress.length === 0) {
        return null;
      }

      const rowBySecp = await this.fetchLatestRegistryRow(
        clickhouseClient,
        `validator_id = '${secpAddress}'`
      );

      if (rowBySecp) {
        rowBySecp.precompile_validator_id = validatorId;
        if ((!rowBySecp.auth_address || rowBySecp.auth_address.length === 0) && validatorInfo?.authAddress) {
          rowBySecp.auth_address = this.normalizeAuthAddress(validatorInfo.authAddress);
        }
        cache.set(validatorId, rowBySecp);
        return rowBySecp;
      }

      const placeholder = this.createPlaceholderRegistryRow(
        validatorId,
        secpAddress,
        validatorInfo,
        epochValue,
        nextTimestampString,
        isConsensus,
        isActiveValidator
      );

      if (placeholder) {
        cache.set(validatorId, placeholder);
        return placeholder;
      }
    } catch (error) {
      logger.warn(`Failed to backfill registry row for validator ${validatorId}:`, error);
    }

    return null;
  }

  private createPlaceholderRegistryRow(
    validatorId: string,
    secpAddress: string,
    validatorInfo: StakingValidator,
    epochValue: number,
    nextTimestampString: () => string,
    isConsensus: boolean,
    isActiveValidator: boolean
  ): any | null {
    try {
      const timestamp = nextTimestampString();
      const stakeBigInt = this.stakingInfo?.validatorStakes.get(validatorId) ?? validatorInfo.stake;
      const stakeString = this.normalizeBigIntLike(stakeBigInt ?? '0');
      const authAddress = this.normalizeAuthAddress(validatorInfo.authAddress);

      return {
        validator_id: secpAddress,
        node_id: secpAddress,
        auth_address: authAddress,
        precompile_validator_id: validatorId,
        stake: stakeString,
        position: 0,
        dns_address: '',
        dns_host: '',
        dns_port: 8000,
        validator_name: 'unknown',
        keybase_id: '',
        keybase_logo_url: '',
        provider: 'unknown',
        location: 'unknown',
        country: 'unknown',
        datacenter: 'unknown',
        first_seen: timestamp,
        last_updated: timestamp,
        epoch: epochValue,
        is_active: isActiveValidator ? 1 : 0,
        is_staking_active: isConsensus ? 1 : 0,
        real_time_stake_wei: stakeString,
        commission: this.normalizeBigIntLike(validatorInfo.commission),
        consensus_commission: this.normalizeBigIntLike(validatorInfo.consensusCommission),
        snapshot_commission: this.normalizeBigIntLike(validatorInfo.snapshotCommission),
        __isPlaceholder: true
      };
    } catch (error) {
      logger.warn(`Failed to create placeholder registry row for validator ${validatorId}:`, error);
      return null;
    }
  }

  private async fetchLatestRegistryRow(
    clickhouseClient: any,
    whereClause: string
  ): Promise<any | null> {
    const query = `
      SELECT
        validator_id,
        node_id,
        auth_address,
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
        real_time_stake_wei,
        commission,
        consensus_commission,
        snapshot_commission,
        last_updated
      FROM validator_registry
      WHERE ${whereClause}
      ORDER BY last_updated DESC
      LIMIT 1
    `;

    const rows = await clickhouseClient.executeRawQuery(query);
    return rows.length > 0 ? rows[0] : null;
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
