import { TokenMetadata } from '../types'

/**
 * Strategy interface for token enrichment
 * Following Strategy Pattern and Open/Closed Principle
 * New enrichment strategies can be added without modifying existing code
 */
export interface ITokenEnrichmentStrategy {
  /**
   * Gets the strategy name
   * @returns Strategy identifier
   */
  getName(): string

  /**
   * Checks if this strategy can handle the given token
   * @param tokenAddress - Token contract address
   * @returns Promise with boolean indicating if strategy can handle token
   */
  canHandle(tokenAddress: string): Promise<boolean>

  /**
   * Enriches token metadata using this strategy
   * @param tokenAddress - Token contract address
   * @returns Promise with token metadata or null if failed
   */
  enrich(tokenAddress: string): Promise<TokenMetadata | null>

  /**
   * Gets the priority of this strategy (higher number = higher priority)
   * @returns Strategy priority
   */
  getPriority(): number

  /**
   * Validates if the enriched metadata is complete and valid
   * @param metadata - Token metadata to validate
   * @returns Boolean indicating if metadata is valid
   */
  isValidMetadata(metadata: TokenMetadata): boolean
} 