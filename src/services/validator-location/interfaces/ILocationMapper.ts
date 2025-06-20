import { ValidatorMapping } from '../types';

export interface ILocationMapper {
  /**
   * Load validator mappings from source
   */
  loadMappings(): Promise<ValidatorMapping[]>;
  
  /**
   * Get mapping for a specific validator
   */
  getMapping(nodeId: string): ValidatorMapping | null;
  
  /**
   * Get all mappings
   */
  getAllMappings(): ValidatorMapping[];
  
  /**
   * Check if mapping exists for validator
   */
  hasMapping(nodeId: string): boolean;
  
  /**
   * Reload mappings from source
   */
  reload(): Promise<void>;
} 