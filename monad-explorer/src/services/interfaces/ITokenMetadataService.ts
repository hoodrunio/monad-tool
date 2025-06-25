import { TokenMetadata } from '../types'

/**
 * Interface for token metadata enrichment service
 * Following Interface Segregation Principle - focused on token metadata only
 */
export interface ITokenMetadataService {
  /**
   * Enriches a single token with metadata
   * @param tokenAddress - The token contract address
   * @returns Promise with token metadata or null if failed
   */
  enrichToken(tokenAddress: string): Promise<TokenMetadata | null>

  /**
   * Enriches multiple tokens with metadata in batches
   * @param tokenAddresses - Array of token contract addresses
   * @returns Promise with array of results (null for failed tokens)
   */
  enrichTokensBatch(tokenAddresses: string[]): Promise<(TokenMetadata | null)[]>

  /**
   * Checks if token metadata exists in cache/database
   * @param tokenAddress - The token contract address
   * @returns Promise with boolean indicating if metadata exists
   */
  hasMetadata(tokenAddress: string): Promise<boolean>

  /**
   * Gets cached metadata without RPC calls
   * @param tokenAddress - The token contract address
   * @returns Promise with cached metadata or null
   */
  getCachedMetadata(tokenAddress: string): Promise<TokenMetadata | null>
} 