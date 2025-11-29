/**
 * Validator Info Update Service
 *
 * Periodically updates validator information from GitHub registry to database
 * Runs every hour to keep validator metadata fresh
 */

import { MonadClickHouseClient } from '../database/clickhouse-client';
import { ValidatorInfoRegistry } from './ValidatorInfoRegistry.js';
import { logger } from '../utils/logger';

export class ValidatorInfoUpdateService {
  private updateTimer?: NodeJS.Timeout;
  private isUpdating: boolean = false;
  private lastUpdateTime: number = 0;
  private updateInterval: number;

  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private validatorInfoRegistry: ValidatorInfoRegistry,
    updateIntervalMs: number = 60 * 60 * 1000 // Default: 1 hour
  ) {
    this.updateInterval = updateIntervalMs;
  }

  /**
   * Start periodic validator info updates
   */
  start(): void {
    logger.info('[ValidatorInfoUpdateService] Starting periodic validator info updates');
    logger.info(`[ValidatorInfoUpdateService] Update interval: ${this.updateInterval / 1000 / 60} minutes`);

    // Run initial update
    this.runUpdate().catch(error => {
      logger.error('[ValidatorInfoUpdateService] Initial update failed:', error);
    });

    // Schedule periodic updates
    this.updateTimer = setInterval(() => {
      this.runUpdate().catch(error => {
        logger.error('[ValidatorInfoUpdateService] Periodic update failed:', error);
      });
    }, this.updateInterval);

    // Ensure timer doesn't prevent process exit
    if (this.updateTimer.unref) {
      this.updateTimer.unref();
    }
  }

  /**
   * Stop periodic updates
   */
  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
      logger.info('[ValidatorInfoUpdateService] Stopped periodic updates');
    }
  }

  /**
   * Run validator info update
   */
  private async runUpdate(): Promise<void> {
    if (this.isUpdating) {
      logger.warn('[ValidatorInfoUpdateService] Update already in progress, skipping');
      return;
    }

    this.isUpdating = true;
    const startTime = Date.now();

    try {
      logger.info('[ValidatorInfoUpdateService] Starting validator info update from GitHub registry');

      // Step 1: Refresh GitHub registry cache
      await this.validatorInfoRegistry.refreshCache();
      const cacheStats = this.validatorInfoRegistry.getCacheStats();
      logger.info(`[ValidatorInfoUpdateService] Loaded ${cacheStats.size} validators from GitHub registry`);

      // Step 2: Get all active validators from database
      const query = `
        SELECT DISTINCT
          validator_id,
          node_id,
          dns_host
        FROM validator_registry
        WHERE is_active = 1
        ORDER BY validator_id
      `;

      const validators = await this.clickhouseClient.executeRawQuery(query);
      logger.info(`[ValidatorInfoUpdateService] Found ${validators.length} active validators in database`);

      // Step 3: Update each validator
      let updateCount = 0;
      let githubCount = 0;
      let fallbackCount = 0;

      for (const validator of validators) {
        const validatorInfo = await this.validatorInfoRegistry.getValidatorInfo(
          validator.node_id || validator.validator_id,
          validator.dns_host
        );

        let name: string;
        let website = '';
        let logoUrl = '';
        let description = '';
        let xHandle = '';

        if (validatorInfo) {
          // Found in GitHub registry
          name = validatorInfo.name;
          website = validatorInfo.website || '';
          logoUrl = validatorInfo.logo || '';
          description = validatorInfo.description || '';
          xHandle = validatorInfo.x || '';
          githubCount++;
        } else if (validator.dns_host) {
          // Fallback to hostname extraction
          name = await this.validatorInfoRegistry.getValidatorName(
            validator.node_id || validator.validator_id,
            validator.dns_host
          );
          fallbackCount++;
        } else {
          continue;
        }

        // Update database
        await this.updateValidatorInfo(
          validator.validator_id,
          name,
          website,
          logoUrl,
          description,
          xHandle
        );

        updateCount++;
      }

      this.lastUpdateTime = Date.now();
      const duration = Date.now() - startTime;

      logger.info(`[ValidatorInfoUpdateService] Update completed in ${duration}ms`);
      logger.info(`[ValidatorInfoUpdateService] Updated ${updateCount} validators (GitHub: ${githubCount}, Hostname: ${fallbackCount})`);

    } catch (error) {
      logger.error('[ValidatorInfoUpdateService] Update failed:', error);
      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Update validator info in database
   */
  private async updateValidatorInfo(
    validatorId: string,
    name: string,
    website: string,
    logoUrl: string,
    description: string,
    xHandle: string
  ): Promise<void> {
    const nowTs = this.formatTimestamp(new Date());

    const updateQuery = `
      INSERT INTO validator_registry
      (validator_id, node_id, precompile_validator_id, epoch, stake, position, is_active, is_staking_active,
       real_time_stake_wei, dns_address, dns_host, dns_port,
       validator_name, validator_website, validator_logo_url, validator_description, validator_x_handle,
       provider, location, country, datacenter, keybase_id, keybase_logo_url, auth_address,
       commission, consensus_commission, snapshot_commission,
       first_seen, last_updated)
      SELECT
        validator_id,
        node_id,
        precompile_validator_id,
        epoch,
        stake,
        position,
        is_active,
        is_staking_active,
        real_time_stake_wei,
        dns_address,
        dns_host,
        dns_port,
        '${this.escapeString(name)}',
        '${this.escapeString(website)}',
        '${this.escapeString(logoUrl)}',
        '${this.escapeString(description)}',
        '${this.escapeString(xHandle)}',
        provider,
        location,
        country,
        datacenter,
        keybase_id,
        keybase_logo_url,
        auth_address,
        commission,
        consensus_commission,
        snapshot_commission,
        first_seen,
        '${nowTs}'
      FROM validator_registry
      WHERE validator_id = '${this.escapeString(validatorId)}'
      ORDER BY last_updated DESC
      LIMIT 1
    `;

    await this.clickhouseClient.executeCommand(updateQuery);
  }

  /**
   * Escape string values for SQL
   */
  private escapeString(value: string): string {
    if (!value) return '';
    return value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "''")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  /**
   * Format Date to ClickHouse DateTime64 format
   */
  private formatTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }

  /**
   * Get service status
   */
  getStatus(): {
    isRunning: boolean;
    isUpdating: boolean;
    lastUpdateTime: number;
    updateInterval: number;
  } {
    return {
      isRunning: this.updateTimer !== undefined,
      isUpdating: this.isUpdating,
      lastUpdateTime: this.lastUpdateTime,
      updateInterval: this.updateInterval
    };
  }

  /**
   * Force an immediate update
   */
  async forceUpdate(): Promise<void> {
    logger.info('[ValidatorInfoUpdateService] Forcing immediate update');
    await this.runUpdate();
  }
}
