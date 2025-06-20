import { ValidatorRegistry, Validator } from '../validator-registry';
import { UnifiedLocationService } from '../unified-location/UnifiedLocationService';
import { ValidatorLocation } from '../validator-location/types';

export interface CompleteValidator {
  // Core validator data (from ValidatorRegistry)
  nodeId: string;
  stake: number;
  certPubkey: string;
  position: number;
  epoch: number;
  
  // Location data (from UnifiedLocationService)
  location?: ValidatorLocation;
  
  // Metadata
  isActive: boolean;
  lastUpdated: Date;
}

export interface ValidatorServiceStats {
  totalValidators: number;
  validatorsWithLocation: number;
  locationCoverage: number;
  currentEpoch: number;
  availableEpochs: number[];
}

/**
 * Clean Validator Service
 * 
 * Properly combines ValidatorRegistry + UnifiedLocationService
 * Following Single Responsibility Principle:
 * - ValidatorRegistry: Core validator data management
 * - UnifiedLocationService: DNS + geolocation  
 * - ValidatorService: Clean orchestration layer
 */
export class ValidatorService {
  private readonly validatorRegistry: ValidatorRegistry;
  private readonly locationService: UnifiedLocationService;
  private isInitialized = false;

  constructor(
    validatorRegistry?: ValidatorRegistry,
    locationService?: UnifiedLocationService
  ) {
    this.validatorRegistry = validatorRegistry || new ValidatorRegistry();
    this.locationService = locationService || new UnifiedLocationService();
  }

  /**
   * Initialize both services
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    console.log('🔧 Initializing ValidatorService...');
    
    try {
      await Promise.all([
        this.validatorRegistry.initialize(),
        this.locationService.initialize()
      ]);
      
      console.log('✅ ValidatorService initialized successfully');
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize ValidatorService:', error);
      throw error;
    }
  }

  /**
   * Process all validator locations (initial setup)
   */
  async processAllValidatorLocations(): Promise<void> {
    console.log('🔄 Processing all validator locations...');
    await this.locationService.processAllValidatorLocations();
    console.log('✅ Validator location processing complete');
  }

  // ===============================
  // Core Validator Methods
  // ===============================

  /**
   * Get complete validator information (registry + location)
   */
  async getValidator(nodeId: string, epoch?: number): Promise<CompleteValidator | null> {
    // Get core validator data
    const validator = this.validatorRegistry.getValidatorById(nodeId, epoch);
    if (!validator) {
      return null;
    }

    // Get location data
    const location = await this.locationService.getValidatorLocation(nodeId);

    return this.buildCompleteValidator(validator, location, epoch);
  }

  /**
   * Get validator synchronously (core data only, no location lookup)
   */
  getValidatorSync(nodeId: string, epoch?: number): CompleteValidator | null {
    const validator = this.validatorRegistry.getValidatorById(nodeId, epoch);
    if (!validator) {
      return null;
    }

    // Check if we have cached location data
    const hasLocation = this.locationService.hasValidatorLocation(nodeId);
    const location = hasLocation ? 
      this.locationService.getValidatorLocation(nodeId) : 
      Promise.resolve(null);

    return this.buildCompleteValidator(validator, null, epoch);
  }

  /**
   * Get validator by position
   */
  async getValidatorByPosition(position: number, epoch?: number): Promise<CompleteValidator | null> {
    const validator = this.validatorRegistry.getValidatorByPosition(position, epoch);
    if (!validator) {
      return null;
    }

    const location = await this.locationService.getValidatorLocation(validator.node_id);
    return this.buildCompleteValidator(validator, location, epoch);
  }

  /**
   * Get multiple validators efficiently
   */
  async getValidators(nodeIds: string[], epoch?: number): Promise<Map<string, CompleteValidator>> {
    const results = new Map<string, CompleteValidator>();
    
    // Get core validator data
    const validators = nodeIds
      .map(nodeId => ({ nodeId, validator: this.validatorRegistry.getValidatorById(nodeId, epoch) }))
      .filter(item => item.validator !== null);

    if (validators.length === 0) {
      return results;
    }

    // Get location data in batch
    const validNodeIds = validators.map(v => v.nodeId);
    const locations = await this.locationService.getValidatorLocations(validNodeIds);

    // Combine data
    validators.forEach(({ nodeId, validator }) => {
      if (validator) {
        const location = locations.get(nodeId) || null;
        const complete = this.buildCompleteValidator(validator, location, epoch);
        results.set(nodeId, complete);
      }
    });

    return results;
  }

  /**
   * Get all validators with complete information
   */
  async getAllValidators(epoch?: number): Promise<CompleteValidator[]> {
    const validators = this.validatorRegistry.getAllValidators(epoch);
    const nodeIds = validators.map(v => v.node_id);
    
    const locations = await this.locationService.getValidatorLocations(nodeIds);
    
    return validators.map(validator => {
      const location = locations.get(validator.node_id) || null;
      return this.buildCompleteValidator(validator, location, epoch);
    });
  }

  // ===============================
  // Registry Passthrough Methods
  // ===============================

  getValidatorCount(epoch?: number): number {
    return this.validatorRegistry.getValidatorCount(epoch);
  }

  getCurrentEpoch(): number {
    return this.validatorRegistry.getCurrentEpoch();
  }

  setCurrentEpoch(epoch: number): void {
    this.validatorRegistry.setCurrentEpoch(epoch);
  }

  getAvailableEpochs(): number[] {
    return this.validatorRegistry.getAvailableEpochs();
  }

  getValidatorPosition(nodeId: string, epoch?: number): number {
    return this.validatorRegistry.getValidatorPosition(nodeId, epoch);
  }

  /**
   * Map BitVec to validators with location data
   */
  async mapBitVecToValidators(
    bitmap: number[], 
    epoch?: number
  ): Promise<Array<{
    validator: CompleteValidator;
    participated: boolean;
  }>> {
    const basicMapping = this.validatorRegistry.mapBitVecToValidators(bitmap, epoch);
    const nodeIds = basicMapping.map(item => item.nodeId);
    const locations = await this.locationService.getValidatorLocations(nodeIds);
    
    return basicMapping.map((item, index) => {
      const validator = this.validatorRegistry.getValidatorById(item.nodeId, epoch);
      if (!validator) {
        throw new Error(`Validator ${item.nodeId} not found in registry`);
      }
      
      const location = locations.get(item.nodeId) || null;
      const complete = this.buildCompleteValidator(validator, location, epoch);
      
      return {
        validator: complete,
        participated: item.participated
      };
    });
  }

  // ===============================
  // Location Analysis Methods  
  // ===============================

  /**
   * Get validators by country
   */
  async getValidatorsByCountry(country: string): Promise<CompleteValidator[]> {
    const locations = this.locationService.getValidatorsByCountry(country);
    const nodeIds = locations.map(loc => loc.nodeId);
    const validatorMap = await this.getValidators(nodeIds);
    return Array.from(validatorMap.values());
  }

  /**
   * Get validators by city
   */
  async getValidatorsByCity(city: string): Promise<CompleteValidator[]> {
    const locations = this.locationService.getValidatorsByCity(city);
    const nodeIds = locations.map(loc => loc.nodeId);
    const validatorMap = await this.getValidators(nodeIds);
    return Array.from(validatorMap.values());
  }

  /**
   * Get validators by ISP
   */
  async getValidatorsByIsp(isp: string): Promise<CompleteValidator[]> {
    const locations = this.locationService.getValidatorsByIsp(isp);
    const nodeIds = locations.map(loc => loc.nodeId);
    const validatorMap = await this.getValidators(nodeIds);
    return Array.from(validatorMap.values());
  }

  /**
   * Get geographic distribution
   */
  getGeographicDistribution(): Map<string, number> {
    return this.locationService.getGeographicDistribution();
  }

  /**
   * Get ISP distribution
   */
  getIspDistribution(): Map<string, number> {
    return this.locationService.getIspDistribution();
  }

  // ===============================
  // Statistics and Cache Management
  // ===============================

  /**
   * Get service statistics
   */
  getStats(): ValidatorServiceStats {
    const registryStats = this.validatorRegistry.getValidatorStats();
    const locationStats = this.locationService.getStats();
    
    return {
      totalValidators: registryStats.totalValidators,
      validatorsWithLocation: locationStats.validatorLocationStats.validatorsWithLocation,
      locationCoverage: locationStats.validatorLocationStats.locationCoverage,
      currentEpoch: this.validatorRegistry.getCurrentEpoch(),
      availableEpochs: this.validatorRegistry.getAvailableEpochs()
    };
  }

  /**
   * Clear location cache
   */
  clearLocationCache(): void {
    this.locationService.clearCache();
  }

  /**
   * Refresh validator location data
   */
  async refreshValidatorLocation(nodeId: string): Promise<CompleteValidator | null> {
    await this.locationService.refreshValidatorLocation(nodeId);
    return await this.getValidator(nodeId);
  }

  // ===============================
  // Private Helper Methods
  // ===============================

  private buildCompleteValidator(
    validator: Validator, 
    location: ValidatorLocation | null, 
    epoch?: number
  ): CompleteValidator {
    return {
      nodeId: validator.node_id,
      stake: validator.stake,
      certPubkey: validator.cert_pubkey,
      position: validator.position,
      epoch: epoch || this.validatorRegistry.getCurrentEpoch(),
      location: location || undefined,
      isActive: true, // Could be enhanced with actual activity detection
      lastUpdated: new Date()
    };
  }

  private normalizeNodeId(nodeId: string): string {
    return nodeId.startsWith('0x') ? nodeId.slice(2).toLowerCase() : nodeId.toLowerCase();
  }
} 