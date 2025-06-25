import { Token } from '../../model'
import { TokenMetadata } from '../types'

/**
 * Interface for token database operations
 * Following Repository Pattern and Interface Segregation Principle
 */
export interface ITokenRepository {
  /**
   * Finds a token by address
   * @param address - Token contract address
   * @returns Promise with token entity or null if not found
   */
  findByAddress(address: string): Promise<Token | null>

  /**
   * Finds multiple tokens by addresses
   * @param addresses - Array of token contract addresses
   * @returns Promise with array of token entities
   */
  findByAddresses(addresses: string[]): Promise<Token[]>

  /**
   * Updates token with metadata
   * @param address - Token contract address
   * @param metadata - Token metadata to update
   * @returns Promise with updated token entity
   */
  updateWithMetadata(address: string, metadata: TokenMetadata): Promise<Token>

  /**
   * Gets tokens that need metadata enrichment
   * @param limit - Maximum number of tokens to return (optional, defaults to 100)
   * @returns Promise with array of token addresses that need enrichment
   */
  getTokensNeedingEnrichment(limit?: number): Promise<string[]>

  /**
   * Checks if token has complete metadata
   * @param address - Token contract address
   * @returns Promise with boolean indicating if metadata is complete
   */
  hasCompleteMetadata(address: string): Promise<boolean>

  /**
   * Counts total tokens
   * @returns Promise with total number of tokens
   */
  count(): Promise<number>

  /**
   * Counts tokens by type
   * @param tokenType - Token type to count
   * @returns Promise with count of tokens of specified type
   */
  countByType(tokenType: string): Promise<number>
} 