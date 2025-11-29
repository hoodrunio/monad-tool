import { MonadIpcClient } from './MonadIpcClient.js';
import { logger } from '../../utils/logger.js';
import { ValidatorLocationService } from '../validator-location/ValidatorLocationService.js';
import { IpcLocationMapper } from '../validator-location/mappers/IpcLocationMapper.js';
import { MonadClickHouseClient } from '../../database/clickhouse-client.js';
import { LocationProcessResult } from '../validator-location/types.js';

interface IpChangeMetrics {
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
  totalIpChanges: number;
  lastPollTime?: Date;
  lastSuccessTime?: Date;
  lastFailureTime?: Date;
}

interface ValidatorIpChange {
  nodeId: string;
  oldIp: string;
  newIp: string;
  timestamp: Date;
}

export class IpcPollingService {
  private readonly ipcMapper: IpcLocationMapper;
  private readonly validatorLocationService: ValidatorLocationService;
  private readonly clickhouseClient: MonadClickHouseClient;
  private readonly pollIntervalMs: number;
  private intervalHandle?: NodeJS.Timeout;
  private isRunning = false;
  private previousMappings: Map<string, string> = new Map(); // nodeId -> IP:port
  private metrics: IpChangeMetrics = {
    totalPolls: 0,
    successfulPolls: 0,
    failedPolls: 0,
    totalIpChanges: 0,
  };

  constructor(
    ipcMapper: IpcLocationMapper,
    validatorLocationService: ValidatorLocationService,
    clickhouseClient: MonadClickHouseClient,
    pollIntervalMs: number = 3600000 // Default: 1 hour
  ) {
    this.ipcMapper = ipcMapper;
    this.validatorLocationService = validatorLocationService;
    this.clickhouseClient = clickhouseClient;
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('IpcPollingService is already running');
      return;
    }

    logger.info(
      `Starting IPC polling service with interval: ${this.pollIntervalMs}ms (${this.pollIntervalMs / 1000 / 60} minutes)`
    );

    // Store initial mappings
    await this.storeCurrentMappings();

    // Start periodic polling
    this.isRunning = true;
    this.intervalHandle = setInterval(async () => {
      await this.poll();
    }, this.pollIntervalMs);

    logger.info('IPC polling service started successfully');
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping IPC polling service...');

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    this.isRunning = false;
    logger.info('IPC polling service stopped');
  }

  private async poll(): Promise<void> {
    this.metrics.totalPolls++;
    this.metrics.lastPollTime = new Date();

    logger.info(`Running IPC poll #${this.metrics.totalPolls}...`);

    try {
      // Reload mappings from IPC
      await this.ipcMapper.reload();

      // Detect IP changes
      const changes = await this.detectIpChanges();

      if (changes.length > 0) {
        logger.info(
          `Detected ${changes.length} validator IP changes:`,
          changes.map((c) => `${c.nodeId}: ${c.oldIp} -> ${c.newIp}`)
        );

        // Process changed validators with new geo data
        await this.processIpChanges(changes);

        this.metrics.totalIpChanges += changes.length;
      } else {
        logger.debug('No validator IP changes detected');
      }

      // Update stored mappings
      await this.storeCurrentMappings();

      this.metrics.successfulPolls++;
      this.metrics.lastSuccessTime = new Date();

      logger.info(
        `IPC poll completed successfully. Stats: ${this.metrics.successfulPolls}/${this.metrics.totalPolls} successful, ${this.metrics.totalIpChanges} total IP changes`
      );
    } catch (error) {
      this.metrics.failedPolls++;
      this.metrics.lastFailureTime = new Date();

      logger.error(
        `IPC poll #${this.metrics.totalPolls} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async storeCurrentMappings(): Promise<void> {
    this.previousMappings.clear();
    const currentMappings = this.ipcMapper.getAllMappings();

    for (const mapping of currentMappings) {
      this.previousMappings.set(mapping.nodeId, mapping.dnsAddress);
    }

    logger.debug(`Stored ${this.previousMappings.size} current validator IP mappings`);
  }

  private async detectIpChanges(): Promise<ValidatorIpChange[]> {
    const changes: ValidatorIpChange[] = [];
    const currentMappings = this.ipcMapper.getAllMappings();

    for (const mapping of currentMappings) {
      const previousIp = this.previousMappings.get(mapping.nodeId);

      if (previousIp && previousIp !== mapping.dnsAddress) {
        changes.push({
          nodeId: mapping.nodeId,
          oldIp: previousIp,
          newIp: mapping.dnsAddress,
          timestamp: new Date(),
        });
      }
    }

    return changes;
  }

  private async processIpChanges(changes: ValidatorIpChange[]): Promise<void> {
    logger.info(`Processing ${changes.length} validator IP changes...`);

    try {
      // Extract unique nodeIds
      const nodeIds = changes.map((c) => c.nodeId);

      // Use the refresh method to update these specific validators
      const results = await this.validatorLocationService.refreshValidatorLocations(nodeIds);

      // Update database with new location data
      await this.updateDatabaseLocations(results);

      logger.info(`Successfully updated ${changes.length} validators with new geo data`);

      // Log each change
      for (const change of changes) {
        logger.info(
          `Validator IP updated: nodeId=${change.nodeId}, oldIp=${change.oldIp}, newIp=${change.newIp}`
        );
      }
    } catch (error) {
      logger.error(
        `Failed to process IP changes: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  private async updateDatabaseLocations(results: LocationProcessResult[]): Promise<void> {
    const successfulResults = results.filter((r) => r.success);

    if (successfulResults.length === 0) {
      logger.warn('No successful location updates to write to database');
      return;
    }

    logger.info(`Updating database with ${successfulResults.length} validator locations...`);

    try {
      for (const result of successfulResults) {
        const loc = result.validator;
        const nowTs = this.formatTimestamp(new Date());

        // Update validator_registry with new location data
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
            '${this.escapeString(loc.dnsAddress)}',
            '${this.escapeString(loc.hostname)}',
            ${loc.port},
            validator_name,
            validator_website,
            validator_logo_url,
            validator_description,
            validator_x_handle,
            COALESCE('${this.escapeString(loc.isp || '')}', provider),
            COALESCE('${this.escapeString(loc.city || '')}', location),
            COALESCE('${this.escapeString(loc.country || '')}', country),
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
          WHERE node_id = '${this.escapeString(loc.nodeId)}'
          ORDER BY last_updated DESC
          LIMIT 1
        `;

        await this.clickhouseClient.executeCommand(updateQuery);
      }

      logger.info(`Successfully updated ${successfulResults.length} validator records in database`);
    } catch (error) {
      logger.error(
        `Failed to update database with new locations: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  private formatTimestamp(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }

  private escapeString(str: string): string {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  getMetrics(): IpChangeMetrics {
    return { ...this.metrics };
  }

  isActive(): boolean {
    return this.isRunning;
  }

  async forcePoll(): Promise<void> {
    logger.info('Force polling requested...');
    await this.poll();
  }
}
