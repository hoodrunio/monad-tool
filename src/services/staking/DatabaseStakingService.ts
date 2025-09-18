// Database-Centric Staking Service
// Single source of truth: Database
// No cache layers, direct database operations

import { ethers } from 'ethers';
import { logger } from '../../utils/logger';
import { MonadClickHouseClient } from '../../database/clickhouse-client';

export interface ValidatorInfo {
  validatorId: string;
  secpPubkey: string;
  stake: bigint;
}

export interface StakingStats {
  totalActiveValidators: number;
  totalValidators: number;
  totalStakeWei: string;
  totalStakeMON: string;
  currentEpoch: string;
  lastUpdated: Date;
}

export class DatabaseStakingService {
  private provider: ethers.JsonRpcProvider;
  private clickhouseClient: MonadClickHouseClient;
  private isInitialized = false;

  constructor(rpcUrl: string, clickhouseClient: MonadClickHouseClient) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.clickhouseClient = clickhouseClient;
    logger.info(`🔗 DatabaseStakingService initialized with RPC: ${rpcUrl}`);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      logger.info('🔧 Initializing Database Staking Service...');
      
      // Test RPC connection
      await this.provider.getBlockNumber();
      
      this.isInitialized = true;
      logger.info('✅ Database Staking Service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize DatabaseStakingService:', error);
      throw error;
    }
  }

  // =============================================
  // PRECOMPILE INTERACTION (Epoch Updates Only)
  // =============================================

  /**
   * Get current epoch from precompile
   */
  async getCurrentEpoch(): Promise<bigint> {
    const result = await this.provider.call({
      to: '0x0000000000000000000000000000000000000068',
      data: '0x76671808' // getCurrentEpoch()
    });

    return ethers.AbiCoder.defaultAbiCoder().decode(['uint64'], result)[0];
  }

  /**
   * Get validator information from precompile
   */
  async getValidatorInfo(validatorId: string): Promise<ValidatorInfo | null> {
    try {
      const result = await this.provider.call({
        to: '0x0000000000000000000000000000000000000068',
        data: '0x' + '5e93ad88' + ethers.AbiCoder.defaultAbiCoder().encode(['uint64'], [BigInt(validatorId)]).slice(2)
      });

      if (result === '0x') {
        return null;
      }

      const decoded = ethers.AbiCoder.defaultAbiCoder().decode([
        'bool',    // registered
        'bytes',   // secp256k1_pubkey
        'bytes',   // bls_pubkey
        'uint256', // stake
        'uint8',   // commission
        'bytes32', // withdrawal_address
        'bool'     // active
      ], result);

      const stake = decoded[3];
      if (!decoded[0] || stake === BigInt(0)) {
        return null;
      }

      return {
        validatorId,
        secpPubkey: ethers.hexlify(decoded[1]),
        stake
      };
    } catch (error) {
      logger.debug(`No validator info for ID ${validatorId}:`, error);
      return null;
    }
  }

  /**
   * Get active validators from precompile (consensus + execution sets)
   */
  async getActiveValidatorIds(): Promise<Set<string>> {
    try {
      const [consensusValidators, executionValidators] = await Promise.all([
        this.getAllValidatorsFromSet('consensus'),
        this.getAllValidatorsFromSet('execution')
      ]);

      const activeSet = new Set<string>();
      consensusValidators.forEach(id => activeSet.add(id));
      executionValidators.forEach(id => activeSet.add(id));

      return activeSet;
    } catch (error) {
      logger.error('Failed to get active validator IDs:', error);
      return new Set();
    }
  }

  /**
   * Get all validators from a specific set (consensus or execution)
   */
  private async getAllValidatorsFromSet(setType: 'consensus' | 'execution'): Promise<string[]> {
    const validators: string[] = [];
    let index = 0;
    const batchSize = 50;

    try {
      while (true) {
        const methodName = setType === 'consensus' ? 'getConsensusValidators' : 'getExecutionValidators';
        const methodSig = setType === 'consensus' ? '0x924ba9d8' : '0x4b37f7c5';
        
        const result = await this.provider.call({
          to: '0x0000000000000000000000000000000000000068',
          data: methodSig + ethers.AbiCoder.defaultAbiCoder().encode(['uint32', 'uint32'], [index, batchSize]).slice(2)
        });

        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bool', 'uint32', 'uint64[]'], result);
        const [done, nextIndex, validatorIds] = decoded;

        validatorIds.forEach((id: bigint) => validators.push(id.toString()));

        if (done) break;
        index = nextIndex;
      }
    } catch (error) {
      logger.warn(`Failed to get ${setType} validators from index ${index}:`, error);
    }

    return validators;
  }

  // =============================================
  // DATABASE OPERATIONS
  // =============================================

  /**
   * STARTUP: Comprehensive validator population from precompile
   */
  async populateAllValidators(currentEpoch: bigint): Promise<void> {
    logger.info('🔍 Starting comprehensive validator population from precompile...');
    
    let validatorCount = 0;
    let consecutiveEmpty = 0;
    const maxEmptyResults = 10;

    // Get active validator set for status marking
    const activeValidatorIds = await this.getActiveValidatorIds();
    
    for (let validatorId = 1; validatorId <= 2000; validatorId++) {
      try {
        const validatorInfo = await this.getValidatorInfo(validatorId.toString());
        
        if (!validatorInfo) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= maxEmptyResults) {
            logger.info(`🏁 Reached end of validators at ID ${validatorId} (${maxEmptyResults} consecutive empty results)`);
            break;
          }
          continue;
        }
        
        consecutiveEmpty = 0;
        validatorCount++;
        
        // Convert secp pubkey to address format
        const secpAddress = validatorInfo.secpPubkey.startsWith('0x') 
          ? validatorInfo.secpPubkey.slice(2) 
          : validatorInfo.secpPubkey;
        
        const isActive = activeValidatorIds.has(validatorId.toString());
        
        // Insert/update validator in database
        await this.insertValidatorRecord({
          validatorId: secpAddress,  // secp address as primary key
          precompileValidatorId: validatorId.toString(),
          epoch: currentEpoch.toString(),
          stake: validatorInfo.stake.toString(),
          isActive: isActive ? 1 : 0,
          isStakingActive: validatorInfo.stake > BigInt(0) ? 1 : 0
        });
        
        if (validatorCount % 50 === 0) {
          logger.info(`📊 Populated ${validatorCount} validators...`);
        }
        
      } catch (error) {
        logger.warn(`Failed to process validator ${validatorId}:`, error);
        continue;
      }
    }
    
    logger.info(`✅ Comprehensive population completed: ${validatorCount} validators processed`);
  }

  /**
   * EPOCH CHANGE: Incremental validator updates
   */
  async performIncrementalUpdate(currentEpoch: bigint): Promise<void> {
    logger.info('🔄 Starting incremental validator update...');
    
    // Get the highest precompile_validator_id from database
    const lastValidatorResult = await this.clickhouseClient.executeRawQuery(`
      SELECT max(toUInt64OrZero(precompile_validator_id)) as last_id
      FROM validator_registry
      WHERE precompile_validator_id != ''
    `);
    
    const lastValidatorId = lastValidatorResult[0]?.last_id || 0;
    const startId = Math.max(1, lastValidatorId - 5); // Check last 5 for safety
    
    logger.info(`📊 Incremental scan starting from validator ID: ${startId}`);
    
    // Get current active validators
    const activeValidatorIds = await this.getActiveValidatorIds();
    
    // Scan for new validators
    let newValidatorCount = 0;
    let consecutiveEmpty = 0;
    
    for (let validatorId = startId; validatorId <= startId + 100; validatorId++) {
      try {
        const validatorInfo = await this.getValidatorInfo(validatorId.toString());
        
        if (!validatorInfo) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 10) break;
          continue;
        }
        
        consecutiveEmpty = 0;
        
        // Check if this is a new validator
        const existingCheck = await this.clickhouseClient.executeRawQuery(`
          SELECT precompile_validator_id
          FROM validator_registry
          WHERE precompile_validator_id = '${validatorId}'
          LIMIT 1
        `);
        
        if (existingCheck.length === 0) {
          newValidatorCount++;
          
          const secpAddress = validatorInfo.secpPubkey.startsWith('0x') 
            ? validatorInfo.secpPubkey.slice(2) 
            : validatorInfo.secpPubkey;
          
          const isActive = activeValidatorIds.has(validatorId.toString());
          
          await this.insertValidatorRecord({
            validatorId: secpAddress,
            precompileValidatorId: validatorId.toString(),
            epoch: currentEpoch.toString(),
            stake: validatorInfo.stake.toString(),
            isActive: isActive ? 1 : 0,
            isStakingActive: validatorInfo.stake > BigInt(0) ? 1 : 0
          });
          
          logger.info(`📍 Added new validator: ID ${validatorId}`);
        }
        
      } catch (error) {
        logger.warn(`Failed to process validator ${validatorId} in incremental update:`, error);
      }
    }
    
    // Update active validator stakes
    await this.updateActiveValidatorStakes(currentEpoch, activeValidatorIds);
    
    logger.info(`✅ Incremental update completed: ${newValidatorCount} new validators found`);
  }

  /**
   * Update stakes for active validators only
   */
  private async updateActiveValidatorStakes(currentEpoch: bigint, activeValidatorIds: Set<string>): Promise<void> {
    logger.info(`🔄 Updating stakes for ${activeValidatorIds.size} active validators...`);
    
    for (const validatorId of activeValidatorIds) {
      try {
        const validatorInfo = await this.getValidatorInfo(validatorId);
        if (!validatorInfo) continue;
        
        // Update existing record
        await this.clickhouseClient.executeCommand(`
          INSERT INTO validator_registry (
            validator_id, precompile_validator_id, epoch, 
            is_active, is_staking_active, real_time_stake_wei, 
            last_stake_update, last_updated
          ) 
          SELECT 
            validator_id,
            precompile_validator_id,
            ${currentEpoch} as epoch,
            1 as is_active,
            ${validatorInfo.stake > BigInt(0) ? 1 : 0} as is_staking_active,
            '${validatorInfo.stake.toString()}' as real_time_stake_wei,
            now() as last_stake_update,
            now() as last_updated
          FROM validator_registry 
          WHERE precompile_validator_id = '${validatorId}'
          ORDER BY last_updated DESC 
          LIMIT 1
        `);
        
      } catch (error) {
        logger.warn(`Failed to update stake for validator ${validatorId}:`, error);
      }
    }
  }

  /**
   * Insert validator record into database
   */
  private async insertValidatorRecord(data: {
    validatorId: string;
    precompileValidatorId: string;
    epoch: string;
    stake: string;
    isActive: number;
    isStakingActive: number;
  }): Promise<void> {
    await this.clickhouseClient.executeCommand(`
      INSERT INTO validator_registry (
        validator_id,
        precompile_validator_id,
        epoch,
        is_active,
        is_staking_active,
        real_time_stake_wei,
        stake,
        last_stake_update,
        last_updated
      ) VALUES (
        '${data.validatorId}',
        '${data.precompileValidatorId}',
        ${data.epoch},
        ${data.isActive},
        ${data.isStakingActive},
        '${data.stake}',
        ${Math.min(Number(data.stake) / Math.pow(10, 18), 999999999)}, -- Convert to approx MON for legacy compatibility
        now(),
        now()
      )
    `);
  }

  // =============================================
  // DATABASE QUERIES (API Layer)
  // =============================================

  /**
   * Get staking statistics from database
   */
  async getStakingStatsFromDB(): Promise<StakingStats> {
    const result = await this.clickhouseClient.executeRawQuery(`
      SELECT 
        count() as total_validators,
        sum(is_staking_active) as active_validators,
        sum(toUInt64OrZero(real_time_stake_wei)) as total_stake_wei,
        max(epoch) as current_epoch,
        max(last_updated) as last_updated
      FROM validator_registry 
      WHERE precompile_validator_id != ''
      AND last_updated = (SELECT max(last_updated) FROM validator_registry)
    `);
    
    const stats = result[0] || {};
    const totalStakeWei = stats.total_stake_wei || '0';
    const totalStakeMON = (Number(totalStakeWei) / Math.pow(10, 18)).toFixed(4);
    
    return {
      totalActiveValidators: Number(stats.active_validators || 0),
      totalValidators: Number(stats.total_validators || 0),
      totalStakeWei,
      totalStakeMON,
      currentEpoch: stats.current_epoch?.toString() || '0',
      lastUpdated: new Date(stats.last_updated || Date.now())
    };
  }

  /**
   * Check if epoch has changed (for update triggering)
   */
  async hasEpochChanged(): Promise<{ changed: boolean; currentEpoch: bigint; dbEpoch: string }> {
    try {
      const currentEpoch = await this.getCurrentEpoch();
      
      const dbResult = await this.clickhouseClient.executeRawQuery(`
        SELECT max(epoch) as db_epoch
        FROM validator_registry
        WHERE precompile_validator_id != ''
      `);
      
      const dbEpoch = dbResult[0]?.db_epoch?.toString() || '0';
      const changed = currentEpoch.toString() !== dbEpoch;
      
      return { changed, currentEpoch, dbEpoch };
    } catch (error) {
      logger.error('Failed to check epoch change:', error);
      return { changed: false, currentEpoch: BigInt(0), dbEpoch: '0' };
    }
  }
}
