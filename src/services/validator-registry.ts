import * as fs from 'fs';
import * as path from 'path';

export interface Validator {
  node_id: string;
  stake: number;
  cert_pubkey: string;
  position: number;
  dns_address?: string; // Adding DNS address mapping
}

export interface ValidatorSet {
  epoch: number;
  validators: Validator[];
}

export interface EpochInterval {
  startEpoch: number;
  endEpoch: number | null; // null means "until next interval"
  validatorSetEpoch: number;
}

export interface DNSMapping {
  node_id: string;
  dns_address: string;
  provider?: string;
  location?: string;
  last_updated: Date;
}

export class ValidatorRegistry {
  private validatorSets: Map<number, ValidatorSet> = new Map();
  private epochIntervals: EpochInterval[] = [];
  private currentEpoch: number = 1;
  private isInitialized: boolean = false;
  private dnsMappings: Map<string, DNSMapping> = new Map(); // node_id -> DNS mapping

  constructor(private validatorsFilePath: string = 'validators/validators.toml') {}

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    try {
      await this.loadValidatorsFromToml();
      this.buildEpochIntervals();
      this.isInitialized = true;
      console.log(`Validator registry initialized with ${this.validatorSets.size} epochs and ${this.epochIntervals.length} intervals`);
    } catch (error) {
      console.error('Failed to initialize validator registry:', error);
      throw error;
    }
  }

  private async loadValidatorsFromToml(): Promise<void> {
    const filePath = path.resolve(this.validatorsFilePath);
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Validators file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    this.parseTomlContent(content);
  }

  private parseTomlContent(content: string): void {
    const lines = content.split('\n');
    let currentEpoch: number | null = null;
    let currentValidators: Validator[] = [];
    let currentValidator: Partial<Validator> = {};
    let position = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Parse epoch
      const epochMatch = line.match(/^epoch = (\d+)$/);
      if (epochMatch) {
        // Save previous epoch if exists
        if (currentEpoch !== null && currentValidators.length > 0) {
          this.validatorSets.set(currentEpoch, {
            epoch: currentEpoch,
            validators: [...currentValidators]
          });
        }
        
        currentEpoch = parseInt(epochMatch[1]);
        currentValidators = [];
        position = 0;
        continue;
      }

      // Parse validator node_id
      const nodeIdMatch = line.match(/^node_id = "(.+)"$/);
      if (nodeIdMatch) {
        currentValidator = { 
          node_id: nodeIdMatch[1],
          position: position++
        };
        continue;
      }

      // Parse stake
      const stakeMatch = line.match(/^stake = (\d+)$/);
      if (stakeMatch && currentValidator.node_id) {
        currentValidator.stake = parseInt(stakeMatch[1]);
        continue;
      }

      // Parse cert_pubkey (completes validator entry)
      const certMatch = line.match(/^cert_pubkey = "(.+)"$/);
      if (certMatch && currentValidator.node_id) {
        currentValidator.cert_pubkey = certMatch[1];
        
        // Validator entry is complete
        if (currentEpoch !== null) {
          currentValidators.push(currentValidator as Validator);
        }
        currentValidator = {};
      }
    }

    // Save the last epoch
    if (currentEpoch !== null && currentValidators.length > 0) {
      this.validatorSets.set(currentEpoch, {
        epoch: currentEpoch,
        validators: [...currentValidators]
      });
    }
  }

  private buildEpochIntervals(): void {
    const availableEpochs = this.getAvailableEpochs();
    this.epochIntervals = [];

    if (availableEpochs.length === 0) {
      throw new Error('No validator sets found');
    }

    // Sort epochs to ensure proper interval building
    availableEpochs.sort((a, b) => a - b);

    for (let i = 0; i < availableEpochs.length; i++) {
      const currentEpoch = availableEpochs[i];
      const nextEpoch = availableEpochs[i + 1];

      let startEpoch: number;
      let endEpoch: number | null;

      if (currentEpoch === 1) {
        // Special case: Epoch 1 covers epochs 1-6
        startEpoch = 1;
        endEpoch = availableEpochs.includes(7) ? 6 : null;
      } else if (currentEpoch === 7) {
        // Special case: Epoch 7 starts from epoch 7
        startEpoch = 7;
        endEpoch = nextEpoch ? nextEpoch - 1 : null;
      } else {
        // General case: Each epoch starts from itself
        startEpoch = currentEpoch;
        endEpoch = nextEpoch ? nextEpoch - 1 : null;
      }

      this.epochIntervals.push({
        startEpoch,
        endEpoch,
        validatorSetEpoch: currentEpoch
      });
    }

    console.log('Built epoch intervals:', this.epochIntervals);
  }

  // Enhanced method to resolve which validator set to use for any epoch
  private resolveValidatorSetEpoch(epoch: number): number {
    // Find the appropriate interval for this epoch
    for (const interval of this.epochIntervals) {
      const inRange = epoch >= interval.startEpoch && 
                     (interval.endEpoch === null || epoch <= interval.endEpoch);
      
      if (inRange) {
        return interval.validatorSetEpoch;
      }
    }

    // Fallback logic based on your requirements
    if (epoch < 7) {
      return 1; // Use epoch 1 data for epochs < 7
    } else {
      return 7; // Use epoch 7 data for epochs >= 7
    }
  }

  setCurrentEpoch(epoch: number): void {
    // No longer need to check if exact epoch exists - we resolve it
    this.currentEpoch = epoch;
  }

  getCurrentEpoch(): number {
    return this.currentEpoch;
  }

  getValidatorByPosition(position: number, epoch?: number): Validator | null {
    const targetEpoch = epoch ?? this.currentEpoch;
    const resolvedEpoch = this.resolveValidatorSetEpoch(targetEpoch);
    const validatorSet = this.validatorSets.get(resolvedEpoch);
    
    if (!validatorSet) {
      console.warn(`Validator set for resolved epoch ${resolvedEpoch} (from epoch ${targetEpoch}) not found`);
      return null;
    }

    return validatorSet.validators[position] || null;
  }

  getValidatorById(nodeId: string, epoch?: number): Validator | null {
    const targetEpoch = epoch ?? this.currentEpoch;
    const resolvedEpoch = this.resolveValidatorSetEpoch(targetEpoch);
    const validatorSet = this.validatorSets.get(resolvedEpoch);
    
    if (!validatorSet) {
      return null;
    }

    return validatorSet.validators.find(v => v.node_id === nodeId) || null;
  }

  getValidatorPosition(nodeId: string, epoch?: number): number {
    const validator = this.getValidatorById(nodeId, epoch);
    return validator ? validator.position : -1;
  }

  getAllValidators(epoch?: number): Validator[] {
    const targetEpoch = epoch ?? this.currentEpoch;
    const resolvedEpoch = this.resolveValidatorSetEpoch(targetEpoch);
    const validatorSet = this.validatorSets.get(resolvedEpoch);
    return validatorSet ? validatorSet.validators : [];
  }

  getValidatorCount(epoch?: number): number {
    return this.getAllValidators(epoch).length;
  }

  getAvailableEpochs(): number[] {
    return Array.from(this.validatorSets.keys()).sort((a, b) => a - b);
  }

  getEpochIntervals(): EpochInterval[] {
    return [...this.epochIntervals];
  }

  // Enhanced method that shows which validator set will be used
  getValidatorSetInfo(epoch?: number): {
    requestedEpoch: number;
    resolvedEpoch: number;
    validatorCount: number;
    interval: EpochInterval | null;
  } {
    const targetEpoch = epoch ?? this.currentEpoch;
    const resolvedEpoch = this.resolveValidatorSetEpoch(targetEpoch);
    const validatorCount = this.getValidatorCount(targetEpoch);
    
    const interval = this.epochIntervals.find(i => 
      targetEpoch >= i.startEpoch && 
      (i.endEpoch === null || targetEpoch <= i.endEpoch)
    ) || null;

    return {
      requestedEpoch: targetEpoch,
      resolvedEpoch,
      validatorCount,
      interval
    };
  }

  // Helper method to map bitvec to actual validator participation
  mapBitVecToValidators(
    bitmap: number[], 
    epoch?: number
  ): Array<{
    validatorId: string;
    nodeId: string;
    participated: boolean;
    position: number;
    stake: number;
  }> {
    const targetEpoch = epoch ?? this.currentEpoch;
    const resolvedEpoch = this.resolveValidatorSetEpoch(targetEpoch);
    const validatorSet = this.validatorSets.get(resolvedEpoch);
    
    if (!validatorSet) {
      throw new Error(`Validator set for resolved epoch ${resolvedEpoch} (from epoch ${targetEpoch}) not found`);
    }

    if (bitmap.length !== validatorSet.validators.length) {
      console.warn(
        `BitVec length (${bitmap.length}) doesn't match validator count (${validatorSet.validators.length}) for epoch ${targetEpoch} (resolved to epoch ${resolvedEpoch})`
      );
    }

    return bitmap.map((bit, index) => {
      const validator = validatorSet.validators[index];
      
      return {
        validatorId: validator?.node_id || `unknown_validator_${index}`,
        nodeId: validator?.node_id || `unknown_validator_${index}`,
        participated: bit === 1,
        position: index,
        stake: validator?.stake || 0
      };
    });
  }

  // Method to detect current epoch from log data - enhanced
  detectEpochFromLogs(validatorId: string): number | null {
    // Check which validator sets contain this validator
    const foundEpochs: number[] = [];
    
    for (const [epoch, validatorSet] of this.validatorSets) {
      if (validatorSet.validators.some(v => v.node_id === validatorId)) {
        foundEpochs.push(epoch);
      }
    }

    if (foundEpochs.length === 0) {
      return null;
    }

    // If validator is in multiple epochs, return the most recent one
    return Math.max(...foundEpochs);
  }

  // Get validator summary statistics
  getValidatorStats(epoch?: number): {
    totalValidators: number;
    totalStake: number;
    averageStake: number;
    highStakeValidators: number;
    lowStakeValidators: number;
    resolvedEpoch: number;
    requestedEpoch: number;
  } {
    const targetEpoch = epoch ?? this.currentEpoch;
    const resolvedEpoch = this.resolveValidatorSetEpoch(targetEpoch);
    const validators = this.getAllValidators(targetEpoch);
    const totalStake = validators.reduce((sum, v) => sum + v.stake, 0);
    const averageStake = validators.length > 0 ? totalStake / validators.length : 0;
    
    return {
      totalValidators: validators.length,
      totalStake,
      averageStake,
      highStakeValidators: validators.filter(v => v.stake > averageStake).length,
      lowStakeValidators: validators.filter(v => v.stake <= averageStake).length,
      resolvedEpoch,
      requestedEpoch: targetEpoch
    };
  }

  // Method to add new epochs dynamically (for future use)
  addValidatorSet(epoch: number, validators: Validator[]): void {
    this.validatorSets.set(epoch, { epoch, validators });
    this.buildEpochIntervals(); // Rebuild intervals
    console.log(`Added new validator set for epoch ${epoch}, rebuilt intervals`);
  }

  // Method to simulate loading new validator sets from updated TOML
  async reload(): Promise<void> {
    this.isInitialized = false;
    this.validatorSets.clear();
    this.epochIntervals = [];
    this.dnsMappings.clear();
    await this.initialize();
  }

  // DNS Mapping Methods
  
  /**
   * Get DNS address for a validator node ID
   */
  getValidatorDNS(nodeId: string): string | null {
    const mapping = this.dnsMappings.get(nodeId);
    return mapping ? mapping.dns_address : null;
  }

  /**
   * Set DNS address for a validator node ID
   */
  setValidatorDNS(nodeId: string, dnsAddress: string, provider?: string, location?: string): void {
    this.dnsMappings.set(nodeId, {
      node_id: nodeId,
      dns_address: dnsAddress,
      provider,
      location,
      last_updated: new Date()
    });
  }

  /**
   * Get all DNS mappings
   */
  getAllDNSMappings(): DNSMapping[] {
    return Array.from(this.dnsMappings.values());
  }

  /**
   * Check if validator has known DNS mapping
   */
  hasValidatorDNS(nodeId: string): boolean {
    return this.dnsMappings.has(nodeId);
  }

  /**
   * Bulk update DNS mappings from external source
   */
  updateDNSMappings(mappings: DNSMapping[]): void {
    for (const mapping of mappings) {
      this.dnsMappings.set(mapping.node_id, {
        ...mapping,
        last_updated: new Date()
      });
    }
  }

  /**
   * Get DNS mappings statistics
   */
  getDNSMappingStats(): {
    totalMapped: number;
    totalValidators: number;
    coveragePercentage: number;
    lastUpdated: Date | null;
  } {
    const totalValidators = this.getAllValidators().length;
    const totalMapped = this.dnsMappings.size;
    const mappings = Array.from(this.dnsMappings.values());
    const lastUpdated = mappings.length > 0 
      ? mappings.reduce((latest, mapping) => 
          mapping.last_updated > latest ? mapping.last_updated : latest, 
          mappings[0].last_updated)
      : null;

    return {
      totalMapped,
      totalValidators,
      coveragePercentage: totalValidators > 0 ? (totalMapped / totalValidators) * 100 : 0,
      lastUpdated
    };
  }
}

// Singleton instance
export const validatorRegistry = new ValidatorRegistry(); 