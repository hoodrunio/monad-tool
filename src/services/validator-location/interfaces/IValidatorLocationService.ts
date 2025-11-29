import { ValidatorLocation, ValidatorLocationStats, LocationProcessResult } from '../types';

export interface IValidatorLocationService {
  /**
   * Initialize service and load validator mappings
   */
  initialize(): Promise<void>;
  
  /**
   * Get location information for a validator
   */
  getValidatorLocation(nodeId: string): Promise<ValidatorLocation | null>;
  
  /**
   * Get location information for multiple validators
   */
  getValidatorLocations(nodeIds: string[]): Promise<Map<string, ValidatorLocation>>;
  
  /**
   * Get all validators with their locations
   */
  getAllValidatorLocations(): Promise<ValidatorLocation[]>;
  
  /**
   * Process all validator locations (initial setup)
   */
  processAllValidatorLocations(): Promise<LocationProcessResult[]>;
  
  /**
   * Refresh location data for a specific validator
   */
  refreshValidatorLocation(nodeId: string): Promise<ValidatorLocation | null>;
  
  /**
   * Get service statistics
   */
  getStats(): ValidatorLocationStats;
  
  /**
   * Check if validator has location data
   */
  hasValidatorLocation(nodeId: string): boolean;
  
  /**
   * Clear all cached data
   */
  clearCache(): void;
  
  /**
   * Get geographic distribution of validators
   */
  getGeographicDistribution(): Map<string, number>;
  
  /**
   * Get ISP distribution of validators
   */
  getIspDistribution(): Map<string, number>;
  
  /**
   * Get validators by country
   */
  getValidatorsByCountry(country: string): ValidatorLocation[];
  
  /**
   * Get validators by city
   */
  getValidatorsByCity(city: string): ValidatorLocation[];
  
  /**
   * Get validators by ISP
   */
  getValidatorsByIsp(isp: string): ValidatorLocation[];
} 