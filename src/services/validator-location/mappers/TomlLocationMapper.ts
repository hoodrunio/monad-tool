import * as fs from 'fs';
import * as path from 'path';
import { ILocationMapper } from '../interfaces/ILocationMapper';
import { ValidatorMapping } from '../types';

export class TomlLocationMapper implements ILocationMapper {
  private mappings: Map<string, ValidatorMapping> = new Map();
  private readonly tomlFilePath: string;
  private isLoaded = false;
  
  constructor(tomlFilePath: string = 'validators/node.toml') {
    this.tomlFilePath = tomlFilePath;
  }
  
  async loadMappings(): Promise<ValidatorMapping[]> {
    const filePath = path.resolve(this.tomlFilePath);
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`TOML configuration file not found: ${filePath}`);
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    this.parseMappings(content);
    this.isLoaded = true;
    
    return Array.from(this.mappings.values());
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
    this.mappings.clear();
    this.isLoaded = false;
    await this.loadMappings();
  }
  
  private parseMappings(content: string): void {
    const lines = content.split('\n');
    let currentAddress: string | null = null;
    let currentPubkey: string | null = null;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }
      
      // Parse address
      const addressMatch = trimmedLine.match(/^address\s*=\s*"(.+)"$/);
      if (addressMatch) {
        currentAddress = addressMatch[1];
        continue;
      }
      
      // Parse secp256k1_pubkey (completes mapping)
      const pubkeyMatch = trimmedLine.match(/^secp256k1_pubkey\s*=\s*"(.+)"$/);
      if (pubkeyMatch && currentAddress) {
        currentPubkey = pubkeyMatch[1];
        
        // Create mapping
        const nodeId = this.normalizeNodeId(currentPubkey);
        const { hostname, port } = this.parseAddress(currentAddress);
        
        const mapping: ValidatorMapping = {
          nodeId,
          dnsAddress: currentAddress,
          hostname,
          port
        };
        
        this.mappings.set(nodeId, mapping);
        
        // Reset for next entry
        currentAddress = null;
        currentPubkey = null;
      }
    }
    
    console.log(`TomlLocationMapper: Loaded ${this.mappings.size} validator mappings`);
  }
  
  private parseAddress(address: string): { hostname: string; port: number } {
    const parts = address.split(':');
    
    if (parts.length === 2) {
      return {
        hostname: parts[0],
        port: parseInt(parts[1]) || 8000
      };
    }
    
    // Handle IPv6 addresses or malformed addresses
    return {
      hostname: address,
      port: 8000
    };
  }
  
  private normalizeNodeId(nodeId: string): string {
    // Remove 0x prefix if present and convert to lowercase
    return nodeId.startsWith('0x') ? nodeId.slice(2).toLowerCase() : nodeId.toLowerCase();
  }
} 