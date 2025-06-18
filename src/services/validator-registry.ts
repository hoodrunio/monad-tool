import * as fs from 'fs';
import * as path from 'path';

export interface Validator {
  node_id: string;
  stake: number;
  cert_pubkey: string;
  position: number;
}

export interface ValidatorSet {
  epoch: number;
  validators: Validator[];
}

export class ValidatorRegistry {
  private validatorSets: Map<number, ValidatorSet> = new Map();
  private currentEpoch: number = 1;
  private isInitialized: boolean = false;

  constructor(private validatorsFilePath: string = 'examples/validators.toml') {}

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    try {
      await this.loadValidatorsFromToml();
      this.isInitialized = true;
      console.log(`Validator registry initialized with ${this.validatorSets.size} epochs`);
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

  setCurrentEpoch(epoch: number): void {
    if (!this.validatorSets.has(epoch)) {
      throw new Error(`Epoch ${epoch} not found in validator registry`);
    }
    this.currentEpoch = epoch;
  }

  getCurrentEpoch(): number {
    return this.currentEpoch;
  }

  getValidatorByPosition(position: number, epoch?: number): Validator | null {
    const targetEpoch = epoch ?? this.currentEpoch;
    const validatorSet = this.validatorSets.get(targetEpoch);
    
    if (!validatorSet) {
      console.warn(`Validator set for epoch ${targetEpoch} not found`);
      return null;
    }

    return validatorSet.validators[position] || null;
  }

  getValidatorById(nodeId: string, epoch?: number): Validator | null {
    const targetEpoch = epoch ?? this.currentEpoch;
    const validatorSet = this.validatorSets.get(targetEpoch);
    
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
    const validatorSet = this.validatorSets.get(targetEpoch);
    return validatorSet ? validatorSet.validators : [];
  }

  getValidatorCount(epoch?: number): number {
    return this.getAllValidators(epoch).length;
  }

  getAvailableEpochs(): number[] {
    return Array.from(this.validatorSets.keys()).sort((a, b) => a - b);
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
    const validatorSet = this.validatorSets.get(targetEpoch);
    
    if (!validatorSet) {
      throw new Error(`Validator set for epoch ${targetEpoch} not found`);
    }

    if (bitmap.length !== validatorSet.validators.length) {
      console.warn(
        `BitVec length (${bitmap.length}) doesn't match validator count (${validatorSet.validators.length}) for epoch ${targetEpoch}`
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

  // Method to detect current epoch from log data
  detectEpochFromLogs(validatorId: string): number | null {
    for (const [epoch, validatorSet] of this.validatorSets) {
      if (validatorSet.validators.some(v => v.node_id === validatorId)) {
        return epoch;
      }
    }
    return null;
  }

  // Get validator summary statistics
  getValidatorStats(epoch?: number): {
    totalValidators: number;
    totalStake: number;
    averageStake: number;
    highStakeValidators: number;
    lowStakeValidators: number;
  } {
    const validators = this.getAllValidators(epoch);
    const totalStake = validators.reduce((sum, v) => sum + v.stake, 0);
    const averageStake = validators.length > 0 ? totalStake / validators.length : 0;
    
    return {
      totalValidators: validators.length,
      totalStake,
      averageStake,
      highStakeValidators: validators.filter(v => v.stake > averageStake).length,
      lowStakeValidators: validators.filter(v => v.stake <= averageStake).length
    };
  }
}

// Singleton instance
export const validatorRegistry = new ValidatorRegistry(); 