import { ILocationMapper } from '../interfaces/ILocationMapper.js';
import { ValidatorMapping } from '../types.js';
import { MonadIpcClient } from '../../ipc/MonadIpcClient.js';
import { logger } from '../../../utils/logger.js';

export class IpcLocationMapper implements ILocationMapper {
  private mappings: Map<string, ValidatorMapping> = new Map();
  private readonly ipcClient: MonadIpcClient;
  private isLoaded = false;

  constructor(socketPath: string) {
    this.ipcClient = new MonadIpcClient(socketPath);
  }

  async loadMappings(): Promise<ValidatorMapping[]> {
    logger.info('Loading validator mappings from IPC...');

    try {
      const peers = await this.ipcClient.getPeers();
      this.parseMappings(peers);
      this.isLoaded = true;

      logger.info(`Successfully loaded ${this.mappings.size} validator mappings from IPC`);
      return Array.from(this.mappings.values());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load mappings from IPC: ${errorMessage}`);
      throw new Error(`IPC mapping load failed: ${errorMessage}`);
    }
  }

  getMapping(nodeId: string): ValidatorMapping | null {
    const normalizedId = this.normalizeNodeId(nodeId);
    return this.mappings.get(normalizedId) || null;
  }

  getAllMappings(): ValidatorMapping[] {
    return Array.from(this.mappings.values());
  }

  hasMapping(nodeId: string): boolean {
    const normalizedId = this.normalizeNodeId(nodeId);
    return this.mappings.has(normalizedId);
  }

  async reload(): Promise<void> {
    logger.info('Reloading validator mappings from IPC...');
    this.mappings.clear();
    this.isLoaded = false;
    await this.loadMappings();
  }

  private parseMappings(peers: Array<{ pubkey: string; addr: string }>): void {
    this.mappings.clear();

    for (const peer of peers) {
      try {
        const nodeId = this.normalizeNodeId(peer.pubkey);
        const { hostname, port } = this.parseAddress(peer.addr);

        const mapping: ValidatorMapping = {
          nodeId,
          dnsAddress: peer.addr,
          hostname,
          port,
        };

        this.mappings.set(nodeId, mapping);
      } catch (error) {
        logger.warn(
          `Skipping invalid peer entry: pubkey=${peer.pubkey}, addr=${peer.addr}, error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    logger.debug(`Parsed ${this.mappings.size} valid validator mappings from IPC`);
  }

  private parseAddress(address: string): { hostname: string; port: number } {
    const parts = address.split(':');

    if (parts.length === 2) {
      return {
        hostname: parts[0],
        port: parseInt(parts[1]) || 8000,
      };
    }

    // Handle IPv6 addresses with port (e.g., [::1]:8000)
    const ipv6Match = address.match(/^\[(.+)\]:(\d+)$/);
    if (ipv6Match) {
      return {
        hostname: ipv6Match[1],
        port: parseInt(ipv6Match[2]) || 8000,
      };
    }

    // Fallback: treat as hostname without port
    logger.warn(`Could not parse port from address: ${address}, using default 8000`);
    return {
      hostname: address,
      port: 8000,
    };
  }

  private normalizeNodeId(nodeId: string): string {
    // Remove 0x prefix if present and convert to lowercase
    return nodeId.startsWith('0x') ? nodeId.slice(2).toLowerCase() : nodeId.toLowerCase();
  }

  async testConnection(): Promise<boolean> {
    return await this.ipcClient.testConnection();
  }
}
