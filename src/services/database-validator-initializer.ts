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

export interface ValidatorDatabaseRecord {
  validator_id: string;
  node_id: string;
  epoch: number;
  stake: number;
  position: number;
  is_active: boolean;
  dns_address: string;
  dns_host: string;
  dns_port: number;
  validator_name: string;
  provider: string;
  location: string;
  country: string;
  datacenter: string;
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

    logger.info('✅ All validator batches processed successfully');
  }

  /**
   * Insert a batch of validators into the database
   */
  private async insertValidatorBatch(validators: any[]): Promise<void> {
    const now = new Date();
    
    const data = validators.map(validator => ({
      validator_id: this.escapeString(validator.nodeId),
      node_id: this.escapeString(validator.nodeId),
      epoch: validator.epoch || 1,
      stake: validator.stake,
      position: validator.position,
      is_active: 1,
      dns_address: this.escapeString(validator.location?.dnsAddress || ''),
      dns_host: this.escapeString(validator.location?.dnsAddress ? validator.location.dnsAddress.split(':')[0] || '' : ''),
      dns_port: validator.location?.dnsAddress ? parseInt(validator.location.dnsAddress.split(':')[1] || '8000') : 8000,
      validator_name: this.escapeString(validator.location?.validatorName || 'unknown'),
      provider: this.escapeString(validator.location?.isp || 'unknown'),
      location: this.escapeString(validator.location ? `${validator.location.city || 'unknown'}, ${validator.location.country || 'unknown'}` : 'unknown'),
      country: this.escapeString(validator.location?.country || 'unknown'),
      datacenter: this.escapeString(validator.location?.isp || 'unknown'),
      first_seen: this.formatTimestamp(now),
      last_updated: this.formatTimestamp(now)
    }));

    try {
      // Use proper parameterized insertion with escaped values
      const values = data.map(d => 
        `('${d.validator_id}', '${d.node_id}', ${d.epoch}, ${d.stake}, ${d.position}, ${d.is_active}, ` +
        `'${d.dns_address}', '${d.dns_host}', ${d.dns_port}, '${d.validator_name}', '${d.provider}', '${d.location}', ` +
        `'${d.country}', '${d.datacenter}', '${d.first_seen}', '${d.last_updated}')`
      ).join(',');

      const insertQuery = `
        INSERT INTO validator_registry 
        (validator_id, node_id, epoch, stake, position, is_active, dns_address, dns_host, dns_port, 
         validator_name, provider, location, country, datacenter, first_seen, last_updated)
        VALUES ${values}
      `;

      logger.info(`💾 Inserting batch of ${data.length} validators...`);
      await this.clickhouseClient.executeCommand(insertQuery);
      logger.info(`✅ Successfully inserted ${data.length} validators into database`);
    } catch (error) {
      logger.error('❌ Failed to insert validator batch:', error);
      logger.error('Query sample:', data.slice(0, 2)); // Log first 2 records for debugging
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
} 
