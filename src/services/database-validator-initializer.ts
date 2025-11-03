/**
 * Database Validator Initializer
 * 
 * Ensures all validators are properly recorded in the database before program startup.
 * This is a critical dependency check that must pass before any log processing begins.
 */

import { MonadClickHouseClient } from '../database/clickhouse-client';
import { ValidatorService } from './unified-validator';
import { ServiceContainer } from './service-container';
import { logger } from '../utils/logger';
import { ValidatorLocation } from './validator-location/types';

export interface ValidatorDatabaseRecord {
  validator_id: string;
  node_id: string;
  auth_address?: string;
  epoch: number;
  precompile_validator_id?: string;
  stake: number;
  position: number;
  is_active: number | boolean;
  is_staking_active?: number | boolean;
  dns_address: string;
  dns_host: string;
  dns_port: number;
  validator_name: string;
  provider: string;
  location: string;
  country: string;
  datacenter: string;
  real_time_stake_wei?: string;
  commission?: string;
  consensus_commission?: string;
  snapshot_commission?: string;
  keybase_id?: string;
  keybase_logo_url?: string;
  first_seen: Date;
  last_updated: Date;
}

export interface DatabaseValidatorStats {
  totalValidators: number;
  validatorsWithDns: number;
  validatorsWithLocation: number;
  validatorsWithProvider: number;
  epochs: number[];
  lastUpdated: Date | null;
  completionRate: number;
  providerCompletionRate: number;
}

export class DatabaseValidatorInitializer {
  private clickhouseClient: MonadClickHouseClient;
  private validatorService: ValidatorService;

  constructor(clickhouseClient: MonadClickHouseClient) {
    this.clickhouseClient = clickhouseClient;
    // Get ValidatorService from service container instead of creating new instance
    const serviceContainer = ServiceContainer.getInstance();
    this.validatorService = serviceContainer.getValidatorService();
  }

  /**
   * Main initialization method - ensures validators are in database
   */
  async ensureValidatorsInDatabase(): Promise<void> {
    logger.info('🔍 Starting database validator initialization check...');

    try {
      await this.clickhouseClient.ensureValidatorRegistryAuthColumns();

      // Step 1: Check current database state
      const currentStats = await this.getDatabaseValidatorStats();
      logger.info('📊 Current database validator stats:', currentStats);

      // Step 2: Determine if we need to initialize
      const needsInitialization = await this.needsValidatorInitialization(currentStats);

      if (!needsInitialization) {
        logger.info('✅ Database validator check passed - all validators are recorded');
        return;
      }

      // Step 3: Perform validator mapping and database population
      logger.info('🔧 Database validation failed - performing validator initialization...');
      await this.initializeValidatorsInDatabase();

      // Step 4: Verify initialization was successful
      const finalStats = await this.getDatabaseValidatorStats();
      logger.info('📈 Post-initialization validator stats:', finalStats);

      if (!await this.needsValidatorInitialization(finalStats)) {
        logger.info('✅ Database validator initialization completed successfully');
      } else {
        throw new Error('Database validator initialization failed - some validators are still missing');
      }

    } catch (error) {
      logger.error('❌ Database validator initialization failed:', error);
      throw new Error(`Critical startup dependency failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Get current validator statistics from database
   */
  async getDatabaseValidatorStats(): Promise<DatabaseValidatorStats & { 
    validatorsWithProvider: number; 
    providerCompletionRate: number; 
  }> {
    try {
      const query = `
        WITH latest_validators AS (
          SELECT
            validator_id,
            dns_address,
            location,
            provider,
            epoch,
            last_updated
          FROM (
            SELECT
              validator_id,
              dns_address,
              location,
              provider,
              epoch,
              last_updated,
              row_number() OVER (PARTITION BY validator_id ORDER BY last_updated DESC) AS rn
            FROM validator_registry
          )
          WHERE rn = 1
        )
        SELECT
          COUNT() AS total_validators,
          SUM(if(ifNull(dns_address, '') = '', 0, 1)) AS validators_with_dns,
          SUM(if(ifNull(location, '') = '' OR lowerUTF8(ifNull(location, '')) = 'unknown', 0, 1)) AS validators_with_location,
          SUM(if(ifNull(provider, '') = '' OR lowerUTF8(ifNull(provider, '')) = 'unknown', 0, 1)) AS validators_with_provider,
          groupArrayDistinct(epoch) AS epochs,
          max(last_updated) AS last_updated
        FROM latest_validators
      `;

      const results = await this.clickhouseClient.executeRawQuery(query);
      
      if (results.length === 0) {
        return {
          totalValidators: 0,
          validatorsWithDns: 0,
          validatorsWithLocation: 0,
          validatorsWithProvider: 0,
          epochs: [],
          lastUpdated: null,
          completionRate: 0,
          providerCompletionRate: 0
        };
      }

      const row = results[0];
      const totalValidators = row.total_validators || 0;
      const validatorsWithLocation = row.validators_with_location || 0;
      const validatorsWithProvider = row.validators_with_provider || 0;

      return {
        totalValidators,
        validatorsWithDns: row.validators_with_dns || 0,
        validatorsWithLocation,
        validatorsWithProvider,
        epochs: row.epochs || [],
        lastUpdated: row.last_updated ? new Date(row.last_updated) : null,
        completionRate: totalValidators > 0 ? (validatorsWithLocation / totalValidators) * 100 : 0,
        providerCompletionRate: totalValidators > 0 ? (validatorsWithProvider / totalValidators) * 100 : 0
      };

    } catch (error) {
      logger.warn('Could not query database validator stats:', error);
      return {
        totalValidators: 0,
        validatorsWithDns: 0,
        validatorsWithLocation: 0,
        validatorsWithProvider: 0,
        epochs: [],
        lastUpdated: null,
        completionRate: 0,
        providerCompletionRate: 0
      };
    }
  }

  /**
   * Determine if validator initialization is needed
   */
  private async needsValidatorInitialization(stats: DatabaseValidatorStats & { 
    validatorsWithProvider: number; 
    providerCompletionRate: number; 
  }): Promise<boolean> {
    // No validators at all - definitely need initialization
    if (stats.totalValidators === 0) {
      logger.info('❌ No validators found in database - initialization required');
      return true;
    }

    // Get expected validator count from ValidatorService (already initialized by service container)
    const expectedValidators = this.validatorService.getStats().totalValidators;

    // Check if we have the expected number of validators
    if (stats.totalValidators < expectedValidators) {
      logger.info(`❌ Database has ${stats.totalValidators} validators, expected ${expectedValidators} - initialization required`);
      return true;
    }

    // Check completion rate - we want at least 80% of validators to have location data
    if (stats.completionRate < 80) {
      logger.info(`❌ Only ${stats.completionRate.toFixed(1)}% of validators have location data - initialization required`);
      return true;
    }

    // CRITICAL: Check provider data quality - we want at least 20% of validators to have real provider data
    // TODO: Investigate why provider completion is low and potentially improve fallback logic
    if (stats.providerCompletionRate < 20) {
      logger.info(`❌ Only ${stats.providerCompletionRate.toFixed(1)}% of validators have provider data (${stats.validatorsWithProvider}/${stats.totalValidators}) - initialization required`);
      return true;
    }

    // Check if data is too old (more than 24 hours)
    if (stats.lastUpdated && (Date.now() - stats.lastUpdated.getTime()) > 24 * 60 * 60 * 1000) {
      logger.info('❌ Validator data is more than 24 hours old - initialization required');
      return true;
    }

    logger.info(`✅ Database validation passed: ${stats.totalValidators} validators, ${stats.completionRate.toFixed(1)}% location completion, ${stats.providerCompletionRate.toFixed(1)}% provider completion`);
    return false;
  }

  /**
   * Initialize validators in database using ValidatorService
   */
  private async initializeValidatorsInDatabase(): Promise<void> {
    logger.info('🔧 Starting validator mapping and database population...');
    logger.info('🚀 Processing validator locations through ValidatorService...');
    await this.validatorService.processAllValidatorLocations();
    
    // Verify location processing worked
    const locationStats = this.validatorService.getStats();
    logger.info(`✅ Location processing complete: ${locationStats.validatorsWithLocation}/${locationStats.totalValidators} validators have location data`);
    
    if (locationStats.validatorsWithLocation === 0) {
      throw new Error('CRITICAL: Location processing failed - no validators have location data');
    }

    // Get all validators from the service (now with proper location data)
    const allValidators = await this.validatorService.getAllValidators();
    logger.info(`📋 Retrieved ${allValidators.length} validators for database insertion`);

    if (allValidators.length === 0) {
      throw new Error('No validators found in ValidatorService - cannot initialize database');
    }

    // VALIDATION: Ensure all validators have necessary data
    let validatorsWithLocation = 0;
    let validatorsWithProvider = 0;
    
    for (const validator of allValidators) {
      if (validator.location) {
        validatorsWithLocation++;
        if (validator.location.isp && validator.location.isp !== 'unknown') {
          validatorsWithProvider++;
        }
      }
    }
    
    logger.info(`📊 Data validation: ${validatorsWithLocation}/${allValidators.length} validators have location, ${validatorsWithProvider}/${allValidators.length} have provider data`);
    
    if (validatorsWithLocation < allValidators.length * 0.8) {
      throw new Error(`CRITICAL: Only ${validatorsWithLocation}/${allValidators.length} validators have location data - expected at least 80%`);
    }

    // Batch process validators for database insertion
    const batchSize = 50;
    const batches = [];
    
    for (let i = 0; i < allValidators.length; i += batchSize) {
      batches.push(allValidators.slice(i, i + batchSize));
    }

    logger.info(`📦 Processing ${batches.length} batches of validators...`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      logger.info(`📦 Processing batch ${i + 1}/${batches.length} (${batch.length} validators)...`);
      await this.insertValidatorBatch(batch);
    }

    logger.info('🔄 Rebuilding validator_registry_latest snapshot to eliminate duplicates...');
    await this.clickhouseClient.rebuildValidatorRegistryLatest();
    logger.info('✅ validator_registry_latest snapshot rebuilt successfully');

    logger.info('✅ All validator batches processed successfully');
  }

  /**
   * Insert a batch of validators into the database
   */
  private async insertValidatorBatch(validators: any[]): Promise<void> {
    const now = new Date();
    const nowFormatted = this.formatTimestamp(now);

    const validatorIds = Array.from(new Set(
      validators
        .map(validator => this.getValidatorPrimaryId(validator))
        .filter((id): id is string => Boolean(id))
    ));

    const existingRows = await this.fetchExistingRegistryRows(validatorIds);

    const rowsToInsert: any[] = [];

    for (const validator of validators) {
      const validatorId = this.getValidatorPrimaryId(validator);
      if (!validatorId) {
        logger.warn('Skipping validator without nodeId/validator_id', validator);
        continue;
      }

      const existing = existingRows.get(validatorId);
      const location = validator.location as (ValidatorLocation | undefined);

      const stakeValue = this.getStakeValue(validator, existing);
      const realTimeStakeValue = this.getRealTimeStakeValue(validator, existing, stakeValue);
      const commissionValue = this.normalizeNumericString(
        (validator as any)?.commission ?? existing?.commission
      );
      const consensusCommissionValue = this.normalizeNumericString(
        (validator as any)?.consensus_commission ?? existing?.consensus_commission
      );
      const snapshotCommissionValue = this.normalizeNumericString(
        (validator as any)?.snapshot_commission ?? existing?.snapshot_commission
      );

      const row = {
        validator_id: validatorId,
        node_id: typeof validator.node_id === 'string' && validator.node_id.length > 0
          ? validator.node_id
          : validatorId,
        auth_address: this.chooseString([
          (validator as any)?.auth_address,
          (validator as any)?.authAddress,
          existing?.auth_address
        ]),
        precompile_validator_id: this.chooseString([
          validator.precompile_validator_id,
          existing?.precompile_validator_id
        ]),
        epoch: this.chooseNumber([
          validator.epoch,
          existing?.epoch
        ], 1),
        stake: stakeValue,
        position: this.chooseNumber([
          validator.position,
          existing?.position
        ], 0),
        is_active: this.chooseNumber([
          validator.isActive,
          validator.is_active,
          existing?.is_active
        ], 1),
        is_staking_active: this.chooseNumber([
          validator.is_staking_active,
          existing?.is_staking_active,
          validator.isActive,
          existing?.is_active
        ], 0),
        real_time_stake_wei: realTimeStakeValue,
        commission: commissionValue,
        consensus_commission: consensusCommissionValue,
        snapshot_commission: snapshotCommissionValue,
        dns_address: this.chooseString([
          location?.dnsAddress,
          validator.dns_address,
          existing?.dns_address
        ]),
        dns_host: this.chooseString([
          location?.hostname,
          validator.dns_host,
          existing?.dns_host,
          this.deriveDnsHost(location?.dnsAddress)
        ]),
        dns_port: this.chooseNumber([
          location?.port,
          validator.dns_port,
          existing?.dns_port
        ], 8000),
        validator_name: this.chooseString([
          location?.validatorName,
          validator.validator_name,
          existing?.validator_name
        ], 'unknown'),
        keybase_id: this.chooseString([
          validator.keybase_id,
          existing?.keybase_id
        ]),
        keybase_logo_url: this.chooseString([
          validator.keybase_logo_url,
          existing?.keybase_logo_url
        ]),
        provider: this.chooseString([
          location?.isp,
          validator.provider,
          existing?.provider
        ], 'unknown'),
        location: this.chooseString([
          location ? this.buildLocationString(location) : undefined,
          validator.location,
          validator.location_string,
          existing?.location
        ], 'unknown'),
        country: this.chooseString([
          location?.country,
          validator.country,
          existing?.country
        ], 'unknown'),
        datacenter: this.chooseString([
          location?.isp,
          validator.datacenter,
          existing?.datacenter
        ], 'unknown'),
        first_seen: this.normalizeTimestamp(
          validator.first_seen || existing?.first_seen,
          nowFormatted
        ),
        last_updated: this.normalizeTimestamp(
          validator.last_updated || existing?.last_updated || now,
          nowFormatted
        )
      };

      rowsToInsert.push(row);
    }

    if (rowsToInsert.length === 0) {
      logger.warn('No validators to insert into registry');
      return;
    }

    try {
      logger.info(`💾 Inserting batch of ${rowsToInsert.length} validators...`);
      await this.clickhouseClient.insertRows('validator_registry', rowsToInsert);
      await this.clickhouseClient.rebuildValidatorRegistryLatest(validatorIds);
      logger.info(`✅ Successfully inserted ${rowsToInsert.length} validators into database`);
    } catch (error) {
      logger.error('❌ Failed to insert validator batch:', error);
      logger.error('Sample rows:', rowsToInsert.slice(0, 2));
      throw error;
    }
  }

  /**
   * Get detailed validator information from database
   */
  async getValidatorFromDatabase(validatorId: string): Promise<ValidatorDatabaseRecord | null> {
    const query = `
      SELECT *
      FROM validator_registry
      WHERE validator_id = '${validatorId}' 
        AND is_active = 1
      ORDER BY last_updated DESC
      LIMIT 1
    `;

    try {
      const results = await this.clickhouseClient.executeRawQuery(query);
      return results.length > 0 ? results[0] as ValidatorDatabaseRecord : null;
    } catch (error) {
      logger.error(`Failed to get validator ${validatorId} from database:`, error);
      return null;
    }
  }

  /**
   * Update validator information in database
   */
  async updateValidatorInDatabase(validatorId: string, updates: Partial<ValidatorDatabaseRecord>): Promise<void> {
    const current = await this.getValidatorFromDatabase(validatorId);
    if (!current) {
      throw new Error(`Validator ${validatorId} not found in database`);
    }

    const updatedValidator = {
      ...current,
      ...updates,
      last_updated: new Date()
    };

    await this.insertValidatorBatch([updatedValidator]);
    logger.info(`🔄 Updated validator ${validatorId} in database`);
  }

  /**
   * Health check for database validator system
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    stats: DatabaseValidatorStats;
    issues: string[];
  }> {
    const stats = await this.getDatabaseValidatorStats();
    const issues: string[] = [];
    
    if (stats.totalValidators === 0) {
      issues.push('No validators found in database');
    }
    
    if (stats.completionRate < 80) {
      issues.push(`Low location completion rate: ${stats.completionRate.toFixed(1)}%`);
    }
    
    if (stats.providerCompletionRate < 20) {
      issues.push(`Low provider completion rate: ${stats.providerCompletionRate.toFixed(1)}%`);
    }
    
    if (stats.lastUpdated && (Date.now() - stats.lastUpdated.getTime()) > 24 * 60 * 60 * 1000) {
      issues.push('Validator data is more than 24 hours old');
    }

    return {
      healthy: issues.length === 0,
      stats,
      issues
    };
  }

  /**
   * Format Date to ClickHouse DateTime64 format
   */
  private formatTimestamp(date: Date): string {
    // Format Date to ClickHouse DateTime64 format: 'YYYY-MM-DD HH:mm:ss.SSS'
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }

  /**
   * Escape string values for SQL to prevent injection and formatting issues
   */
  private escapeString(value: string): string {
    if (!value) return '';
    
    // Escape single quotes and other problematic characters
    return value
      .replace(/'/g, "''")  // Escape single quotes
      .replace(/\\/g, '\\\\') // Escape backslashes
      .replace(/\n/g, '\\n')  // Escape newlines
      .replace(/\r/g, '\\r'); // Escape carriage returns
  }

  private async fetchExistingRegistryRows(validatorIds: string[]): Promise<Map<string, any>> {
    if (validatorIds.length === 0) {
      return new Map();
    }

    const escapedList = Array.from(new Set(validatorIds)).map(id => `'${this.escapeString(id)}'`).join(',');
    const query = `
      SELECT
        validator_id,
        argMax(precompile_validator_id, last_updated) AS precompile_validator_id,
        argMax(epoch, last_updated) AS epoch,
        argMax(stake, last_updated) AS stake,
        argMax(position, last_updated) AS position,
        argMax(is_active, last_updated) AS is_active,
        argMax(is_staking_active, last_updated) AS is_staking_active,
        COALESCE(argMaxIf(real_time_stake_wei, last_updated, real_time_stake_wei != ''), argMax(real_time_stake_wei, last_updated)) AS real_time_stake_wei,
        COALESCE(argMaxIf(commission, last_updated, commission != '' AND commission != '0'), argMax(commission, last_updated)) AS commission,
        COALESCE(argMaxIf(consensus_commission, last_updated, consensus_commission != '' AND consensus_commission != '0'), argMax(consensus_commission, last_updated)) AS consensus_commission,
        COALESCE(argMaxIf(snapshot_commission, last_updated, snapshot_commission != '' AND snapshot_commission != '0'), argMax(snapshot_commission, last_updated)) AS snapshot_commission,
        COALESCE(argMaxIf(auth_address, last_updated, auth_address != ''), argMax(auth_address, last_updated)) AS auth_address,
        COALESCE(argMaxIf(dns_address, last_updated, dns_address != ''), argMax(dns_address, last_updated)) AS dns_address,
        COALESCE(argMaxIf(dns_host, last_updated, dns_host != ''), argMax(dns_host, last_updated)) AS dns_host,
        COALESCE(argMaxIf(dns_port, last_updated, dns_port != 0), argMax(dns_port, last_updated)) AS dns_port,
        COALESCE(argMaxIf(validator_name, last_updated, validator_name != '' AND validator_name != 'unknown'), argMax(validator_name, last_updated)) AS validator_name,
        COALESCE(argMaxIf(provider, last_updated, provider != '' AND provider != 'unknown'), argMax(provider, last_updated)) AS provider,
        COALESCE(argMaxIf(location, last_updated, location != '' AND location != 'unknown'), argMax(location, last_updated)) AS location,
        COALESCE(argMaxIf(country, last_updated, country != '' AND country != 'unknown'), argMax(country, last_updated)) AS country,
        COALESCE(argMaxIf(datacenter, last_updated, datacenter != '' AND datacenter != 'unknown'), argMax(datacenter, last_updated)) AS datacenter,
        COALESCE(argMaxIf(keybase_id, last_updated, keybase_id != ''), argMax(keybase_id, last_updated)) AS keybase_id,
        COALESCE(argMaxIf(keybase_logo_url, last_updated, keybase_logo_url != ''), argMax(keybase_logo_url, last_updated)) AS keybase_logo_url,
        argMax(first_seen, last_updated) AS first_seen,
        argMax(last_updated, last_updated) AS last_updated
      FROM validator_registry
      WHERE validator_id IN (${escapedList})
      GROUP BY validator_id
    `;

    const rows = await this.clickhouseClient.executeRawQuery(query);
    const map = new Map<string, any>();

    for (const row of rows) {
      if (row?.validator_id) {
        map.set(row.validator_id, row);
      }
    }

    return map;
  }

  private getValidatorPrimaryId(validator: any): string | null {
    const candidates = [validator?.nodeId, validator?.validator_id, validator?.node_id];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return null;
  }

  private deriveDnsHost(dnsAddress?: string): string | undefined {
    if (!dnsAddress || typeof dnsAddress !== 'string') {
      return undefined;
    }
    return dnsAddress.split(':')[0] || undefined;
  }

  private buildLocationString(location?: ValidatorLocation): string | undefined {
    if (!location) {
      return undefined;
    }

    const city = location.city?.trim();
    const country = location.country?.trim();

    if (city && country) {
      return `${city}, ${country}`;
    }

    return city || country || undefined;
  }

  private normalizeTimestamp(value: Date | string | null | undefined, fallback: string): string {
    if (value instanceof Date) {
      return this.formatTimestamp(value);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return fallback;
      }

      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
        return trimmed;
      }

      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return this.formatTimestamp(parsed);
      }
    }

    return fallback;
  }

  private normalizeNumericString(value: any, fallback = '0'): string {
    if (value === null || value === undefined) {
      return fallback;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return fallback;
      }
      // Use toFixed(0) to prevent scientific notation for very large numbers
      return value.toFixed(0);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : fallback;
    }

    return fallback;
  }

  private chooseString(values: Array<string | undefined | null>, fallback = ''): string {
    for (const value of values) {
      if (typeof value !== 'string') {
        continue;
      }

      const trimmed = value.trim();
      if (trimmed.length === 0) {
        continue;
      }

      return trimmed;
    }

    return fallback;
  }

  private chooseNumber(values: Array<number | string | boolean | undefined>, fallback: number): number {
    for (const value of values) {
      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'boolean') {
        return value ? 1 : 0;
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          continue;
        }

        const numeric = Number(trimmed);
        if (!Number.isNaN(numeric)) {
          return numeric;
        }
        continue;
      }

      if (typeof value === 'number' && !Number.isNaN(value)) {
        return value;
      }
    }

    return fallback;
  }

  private getStakeValue(validator: any, existing: any): string {
    const values = [
      validator.stake,
      validator.validator_stake,
      existing?.stake,
      existing?.real_time_stake_wei
    ];

    for (const value of values) {
      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'bigint') {
        return value.toString();
      }

      if (typeof value === 'number') {
        if (Number.isFinite(value)) {
          // Use toFixed(0) to prevent scientific notation for very large numbers
          return value.toFixed(0);
        }
        continue;
      }

      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return '0';
  }

  private getRealTimeStakeValue(validator: any, existing: any, fallbackStake: string): string {
    const values = [
      validator.real_time_stake_wei,
      existing?.real_time_stake_wei,
      fallbackStake
    ];

    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
      if (typeof value === 'number') {
        // Use toFixed(0) to prevent scientific notation for very large numbers
        return value.toFixed(0);
      }
      if (typeof value === 'bigint') {
        return value.toString();
      }
    }

    return fallbackStake;
  }
}
