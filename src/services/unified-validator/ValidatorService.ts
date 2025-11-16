import { ValidatorRegistry, Validator } from '../validator-registry';
import { UnifiedLocationService } from '../unified-location/UnifiedLocationService';
import { ValidatorLocation } from '../validator-location/types';
import { MonadClickHouseClient } from '../../database/clickhouse-client';

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
  private readonly clickhouseClient?: MonadClickHouseClient;
  private isInitialized = false;

  constructor(
    validatorRegistry?: ValidatorRegistry,
    locationService?: UnifiedLocationService,
    clickhouseClient?: MonadClickHouseClient
  ) {
    this.validatorRegistry = validatorRegistry || new ValidatorRegistry();
    this.locationService = locationService || new UnifiedLocationService();
    this.clickhouseClient = clickhouseClient;
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
   * Falls back to database if not found in memory
   */
  async getValidator(nodeId: string, epoch?: number): Promise<CompleteValidator | null> {
    // Get core validator data from in-memory registry
    let validator = this.validatorRegistry.getValidatorById(nodeId, epoch);

    // If not found in memory and we have database client, try database
    if (!validator && this.clickhouseClient) {
      const normalizedId = nodeId.toLowerCase().replace(/^0x/, '');
      const query = `
        SELECT
          validator_id,
          node_id,
          auth_address,
          stake,
          cert_pubkey,
          is_active
        FROM validator_registry_latest
        WHERE node_id = '${normalizedId}'
        LIMIT 1
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);
      if (result && result.length > 0) {
        const dbValidator = result[0];
        validator = {
          node_id: dbValidator.node_id,
          stake: parseFloat(dbValidator.stake || '0'),
          cert_pubkey: dbValidator.cert_pubkey,
          position: -1 // Position not available from DB
        };
      }
    }

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
   * Get geographic distribution - ONLY active validators
   */
  async getGeographicDistribution(): Promise<Map<string, number>> {
    if (this.clickhouseClient) {
      try {
        const query = `
          SELECT
            location,
            COUNT(*) as validator_count
          FROM validator_registry_latest
          WHERE is_staking_active = 1
            AND location IS NOT NULL
            AND location != ''
            AND location != 'unknown'
          GROUP BY location
        `;
        
        const result = await this.clickhouseClient.executeRawQuery(query);
        const distribution = new Map<string, number>();
        
        result.forEach(row => {
          distribution.set(row.location, parseInt(row.validator_count));
        });
        
        return distribution;
      } catch (error) {
        console.error('Failed to get geographic distribution from database, falling back to location service:', error);
      }
    }
    
    // Fallback to location service
    return this.locationService.getGeographicDistribution();
  }

  /**
   * Get ISP distribution - ONLY active validators
   */
  async getIspDistribution(): Promise<Map<string, number>> {
    if (this.clickhouseClient) {
      try {
        const query = `
          SELECT
            provider,
            COUNT(*) as validator_count
          FROM validator_registry_latest
          WHERE is_staking_active = 1
            AND provider IS NOT NULL
            AND provider != ''
            AND provider != 'unknown'
          GROUP BY provider
        `;
        
        const result = await this.clickhouseClient.executeRawQuery(query);
        const distribution = new Map<string, number>();
        
        result.forEach(row => {
          distribution.set(row.provider, parseInt(row.validator_count));
        });
        
        return distribution;
      } catch (error) {
        console.error('Failed to get ISP distribution from database, falling back to location service:', error);
      }
    }
    
    // Fallback to location service
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
   * Get accurate validator statistics from database
   */
  async getAccurateStats(): Promise<ValidatorServiceStats & {
    uniqueValidators: number;
    validatorsWithLocationData: number;
    locationCoveragePercent: number;
    uniqueLocations: number;
    uniqueProviders: number;
  }> {
    // We need to inject a database client to get accurate stats
    // For now, return enhanced stats based on location service data
    const geoDistribution = this.locationService.getGeographicDistribution();
    const ispDistribution = this.locationService.getIspDistribution();
    
    // Calculate stats from location service data
    const validatorsWithLocationData = Array.from(geoDistribution.values()).reduce((sum, count) => sum + count, 0);
    const totalFromLocation = Math.max(validatorsWithLocationData, Array.from(ispDistribution.values()).reduce((sum, count) => sum + count, 0));
    
    return {
      totalValidators: totalFromLocation || this.validatorRegistry.getValidatorStats().totalValidators,
      validatorsWithLocation: validatorsWithLocationData,
      locationCoverage: totalFromLocation > 0 ? (validatorsWithLocationData / totalFromLocation) * 100 : 0,
      currentEpoch: this.validatorRegistry.getCurrentEpoch(),
      availableEpochs: this.validatorRegistry.getAvailableEpochs(),
      uniqueValidators: totalFromLocation,
      validatorsWithLocationData,
      locationCoveragePercent: totalFromLocation > 0 ? (validatorsWithLocationData / totalFromLocation) * 100 : 0,
      uniqueLocations: geoDistribution.size,
      uniqueProviders: ispDistribution.size
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