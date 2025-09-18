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

  // Validator mapping caches - these are persistent and rarely change
  private validatorIdToSecpMapping: Map<string, string> = new Map(); // precompile_id -> secp_address
  private secpToValidatorIdMapping: Map<string, string> = new Map(); // secp_address -> precompile_id
  private validatorStakeCache: Map<string, {stake: bigint, lastUpdate: Date}> = new Map(); // precompile_id -> stake_info
  private lastMappingUpdate: Date = new Date(0);
  private readonly MAPPING_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly STAKE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private isInitialized = false;

  // COMPREHENSIVE VALIDATOR CACHE - Updated only on epoch changes
  private comprehensiveValidatorCache: Map<string, {validatorId: string, stake: bigint, isActive: boolean}> = new Map();
  private lastComprehensiveScan: Date = new Date(0);
  private readonly COMPREHENSIVE_SCAN_TTL = 60 * 60 * 1000; // 1 hour max

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
  // OPTIMIZED CACHE METHODS
  // =============================================

  /**
   * Ensure validator mapping exists in cache (lazy loading)
   * Only calls precompile if mapping doesn't exist
   */
  private async ensureValidatorMapping(validatorId: string): Promise<string | null> {
    // Check cache first
    const cachedSecpAddress = this.validatorIdToSecpMapping.get(validatorId);
    if (cachedSecpAddress) {
      return cachedSecpAddress;
    }

    try {
      // Get from precompile (only for new validators)
      const validatorInfo = await this.getValidatorInfo(validatorId);
      if (validatorInfo && validatorInfo.secpPubkey) {
        const secpAddress = validatorInfo.secpPubkey.startsWith('0x') 
          ? validatorInfo.secpPubkey.slice(2) 
          : validatorInfo.secpPubkey;
        
        // Cache the mapping
        this.validatorIdToSecpMapping.set(validatorId, secpAddress);
        this.secpToValidatorIdMapping.set(secpAddress, validatorId);
        
        logger.info(`📍 Cached new validator mapping: ${validatorId} → ${secpAddress}`);
        return secpAddress;
      }
    } catch (error) {
      logger.warn(`Failed to get secp address for validator ${validatorId}:`, error);
    }

    return null;
  }

  /**
   * Get secp address from cache (optimized, no precompile calls)
   */
  getSecpAddressFromCache(validatorId: string): string | null {
    return this.validatorIdToSecpMapping.get(validatorId) || null;
  }

  /**
   * Get precompile validator ID from secp address
   */
  getValidatorIdFromSecpAddress(secpAddress: string): string | null {
    return this.secpToValidatorIdMapping.get(secpAddress) || null;
  }

  /**
   * OPTIMIZED: Get secp addresses for active validators (from cache)
   * No precompile calls unless mapping is missing
   */
  async getActiveValidatorSecpAddresses(): Promise<string[]> {
    const activeIds = this.getActiveValidatorIds();
    const secpAddresses: string[] = [];
    
    for (const validatorId of activeIds) {
      const secpAddress = await this.ensureValidatorMapping(validatorId);
      if (secpAddress) {
        secpAddresses.push(secpAddress);
      }
    }
    
    logger.info(`🔑 Retrieved ${secpAddresses.length} secp addresses for ${activeIds.length} active validators (cache optimized)`);
    return secpAddresses;
  }

  /**
   * OPTIMIZED: Get validator mappings (from cache, updated only on epoch changes)
   */
  async getValidatorMappingBySecpAddress(): Promise<Map<string, {validatorId: string, stake: bigint, isActive: boolean}>> {
    // Use cached comprehensive data - NO real-time scanning on API requests!
    if (this.comprehensiveValidatorCache.size > 0) {
      // Use debug level to avoid spam
      return new Map(this.comprehensiveValidatorCache);
    }

    // Fallback: if no comprehensive cache, use active validators only (fast path)
    logger.warn('📊 No comprehensive cache available, falling back to active validators only');
    return this.getActiveValidatorMappingOnly();
  }

  /**
   * FAST FALLBACK: Get only active validator mappings (no comprehensive scan)
   */
  private async getActiveValidatorMappingOnly(): Promise<Map<string, {validatorId: string, stake: bigint, isActive: boolean}>> {
    const mapping = new Map<string, {validatorId: string, stake: bigint, isActive: boolean}>();
    const activeIds = this.getActiveValidatorIds();
    
    for (const validatorId of activeIds) {
      const secpAddress = await this.ensureValidatorMapping(validatorId);
      if (secpAddress) {
        const stake = this.stakingInfo?.validatorStakes.get(validatorId) || BigInt(0);
        mapping.set(secpAddress, {
          validatorId,
          stake,
          isActive: true
        });
      }
    }
    
    return mapping;
  }

  /**
   * COMPREHENSIVE: Get ALL validators with stake (1 to N, until result is 0)
   * This includes both active and inactive validators
   */
  async getAllValidatorsWithStake(): Promise<Map<string, {stake: bigint, secpPubkey?: string}>> {
    const validators = new Map<string, {stake: bigint, secpPubkey?: string}>();
    
    logger.info('🔍 Scanning ALL validators with stake (comprehensive approach)...');
    
    // Start from validator ID 1 and continue until we get null/empty result
    for (let validatorId = 1; validatorId <= 1000; validatorId++) {
      try {
        const validatorInfo = await this.getValidatorInfo(validatorId.toString());
        
        if (!validatorInfo || !validatorInfo.stake || validatorInfo.stake === BigInt(0)) {
          // If we get 5 consecutive empty results, assume we've reached the end
          let emptyCount = 0;
          for (let checkId = validatorId; checkId < validatorId + 5 && checkId <= 1000; checkId++) {
            const checkInfo = await this.getValidatorInfo(checkId.toString());
            if (!checkInfo || !checkInfo.stake || checkInfo.stake === BigInt(0)) {
              emptyCount++;
            } else {
              break;
            }
          }
          
          if (emptyCount >= 5) {
            logger.info(`🏁 Reached end of validators at ID ${validatorId} (5 consecutive empty results)`);
            break;
          }
          continue;
        }
        
        validators.set(validatorId.toString(), {
          stake: validatorInfo.stake,
          secpPubkey: validatorInfo.secpPubkey
        });
        
        if (validatorId % 10 === 0) {
          logger.info(`📊 Scanned ${validatorId} validators, found ${validators.size} with stake`);
        }
        
      } catch (error) {
        logger.warn(`Failed to get validator info for ID ${validatorId}:`, error);
        // Continue scanning even if one fails
      }
    }
    
    logger.info(`✅ Comprehensive scan complete: Found ${validators.size} validators with stake`);
    return validators;
  }

  /**
   * UPDATE COMPREHENSIVE CACHE - Only called on epoch changes!
   */
  async updateComprehensiveValidatorCache(): Promise<void> {
    logger.info('🔄 Updating comprehensive validator cache (epoch change detected)...');
    
    try {
      // Get all validators with stake
      const allValidators = await this.getAllValidatorsWithStake();
      
      // Clear and rebuild comprehensive cache
      this.comprehensiveValidatorCache.clear();
      
      for (const [validatorId, validatorInfo] of allValidators.entries()) {
        const secpAddress = await this.ensureValidatorMapping(validatorId);
        if (secpAddress) {
          const isActive = this.stakingInfo?.activeValidators.has(validatorId) || false;
          this.comprehensiveValidatorCache.set(secpAddress, {
            validatorId,
            stake: validatorInfo.stake,
            isActive
          });
        }
      }
      
      this.lastComprehensiveScan = new Date();
      logger.info(`✅ Comprehensive cache updated: ${this.comprehensiveValidatorCache.size} validators cached`);
      
    } catch (error) {
      logger.error('Failed to update comprehensive validator cache:', error);
    }
  }

  /**
   * INCREMENTAL: Scan for new validators starting from a specific ID
   */
  async scanNewValidators(startId: number): Promise<Map<string, {stake: bigint, secpPubkey?: string}>> {
    const newValidators = new Map<string, {stake: bigint, secpPubkey?: string}>();
    
    logger.info(`🔍 Incremental scan: checking validators from ID ${startId}...`);
    
    // Scan from startId until we hit consecutive empty results
    for (let validatorId = startId; validatorId <= startId + 100; validatorId++) {
      try {
        const validatorInfo = await this.getValidatorInfo(validatorId.toString());
        
        if (!validatorInfo || !validatorInfo.stake || validatorInfo.stake === BigInt(0)) {
          // Check if we've hit the end (5 consecutive empty results)
          let emptyCount = 0;
          for (let checkId = validatorId; checkId < validatorId + 5 && checkId <= startId + 100; checkId++) {
            const checkInfo = await this.getValidatorInfo(checkId.toString());
            if (!checkInfo || !checkInfo.stake || checkInfo.stake === BigInt(0)) {
              emptyCount++;
            } else {
              break;
            }
          }
          
          if (emptyCount >= 5) {
            logger.info(`🏁 Incremental scan ended at ID ${validatorId} (5 consecutive empty results)`);
            break;
          }
          continue;
        }
        
        newValidators.set(validatorId.toString(), {
          stake: validatorInfo.stake,
          secpPubkey: validatorInfo.secpPubkey
        });
        
        if (validatorId % 10 === 0 && newValidators.size > 0) {
          logger.info(`📊 Incremental scan: found ${newValidators.size} new validators up to ID ${validatorId}`);
        }
        
      } catch (error) {
        logger.warn(`Failed to check validator ID ${validatorId} during incremental scan:`, error);
      }
    }
    
    logger.info(`✅ Incremental scan complete: Found ${newValidators.size} new validators`);
    return newValidators;
  }

  /**
   * Add new validators to comprehensive cache
   */
  async addNewValidatorsToCache(newValidators: Map<string, {stake: bigint, secpPubkey?: string}>): Promise<void> {
    logger.info(`📝 Adding ${newValidators.size} new validators to cache...`);
    
    for (const [validatorId, validatorInfo] of newValidators.entries()) {
      try {
        // Get secp address mapping
        const secpAddress = await this.ensureValidatorMapping(validatorId);
        if (secpAddress) {
          const isActive = this.stakingInfo?.activeValidators.has(validatorId) || false;
          
          // Add to comprehensive cache
          this.comprehensiveValidatorCache.set(secpAddress, {
            validatorId,
            stake: validatorInfo.stake,
            isActive
          });
          
          logger.debug(`📍 Added validator ${validatorId} (${secpAddress}) to cache`);
        }
      } catch (error) {
        logger.warn(`Failed to add validator ${validatorId} to cache:`, error);
      }
    }
    
    logger.info(`✅ Successfully added ${newValidators.size} new validators to cache`);
  }

  /**
   * Update specific validator stake in cache
   */
  updateValidatorStakeInCache(validatorId: string, newStake: bigint): void {
    // Update in comprehensive cache
    for (const [secpAddress, validatorData] of this.comprehensiveValidatorCache.entries()) {
      if (validatorData.validatorId === validatorId) {
        validatorData.stake = newStake;
        logger.debug(`💰 Updated stake for validator ${validatorId}: ${newStake.toString()}`);
        break;
      }
    }
    
    // Update in staking info if available
    if (this.stakingInfo && this.stakingInfo.validatorStakes.has(validatorId)) {
      this.stakingInfo.validatorStakes.set(validatorId, newStake);
    }
  }

  /**
   * Load existing validator mappings from database (initialization)
   */
  async loadValidatorMappingsFromDatabase(clickhouseClient: any): Promise<void> {
    try {
      const query = `
        SELECT DISTINCT
          validator_id as secp_address,
          node_id as validator_id
        FROM validator_registry
        WHERE node_id != '' AND node_id != validator_id
        ORDER BY last_updated DESC
      `;
      
      const results = await clickhouseClient.executeRawQuery(query);
      
      for (const row of results) {
        if (row.validator_id && row.secp_address) {
          this.validatorIdToSecpMapping.set(row.validator_id, row.secp_address);
          this.secpToValidatorIdMapping.set(row.secp_address, row.validator_id);
        }
      }
      
      this.lastMappingUpdate = new Date();
      logger.info(`📚 Loaded ${this.validatorIdToSecpMapping.size} validator mappings from database`);
    } catch (error) {
      logger.warn('Failed to load validator mappings from database:', error);
    }
  }
}
