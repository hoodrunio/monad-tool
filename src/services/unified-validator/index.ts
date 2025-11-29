// Main validator service
export { ValidatorService } from './ValidatorService';

// Types
export type { CompleteValidator, ValidatorServiceStats } from './ValidatorService';

// Re-export core validator types from registry
export type { Validator, ValidatorSet, EpochInterval } from '../validator-registry';

// Re-export location types  
export type { ValidatorLocation } from '../validator-location/types';

// Import for factory function
import { ValidatorService } from './ValidatorService';

/**
 * Factory function to create ValidatorService with default configuration
 */
export function createValidatorService(): ValidatorService {
  return new ValidatorService();
} 