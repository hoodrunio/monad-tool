import { ITokenEnrichmentStrategy } from './ITokenEnrichmentStrategy'
import { TokenMetadata } from '../types'

/**
 * Base abstract class for token enrichment strategies
 * Following Template Method Pattern and providing common functionality
 * Following Open/Closed Principle - concrete strategies extend without modifying base
 */
export abstract class BaseTokenEnrichmentStrategy implements ITokenEnrichmentStrategy {
  protected readonly name: string
  protected readonly priority: number

  constructor(name: string, priority: number) {
    this.name = name
    this.priority = priority
  }

  /**
   * Gets the strategy name
   * @returns Strategy identifier
   */
  getName(): string {
    return this.name
  }

  /**
   * Gets the priority of this strategy
   * @returns Strategy priority
   */
  getPriority(): number {
    return this.priority
  }

  /**
   * Template method for enriching token metadata
   * Following Template Method Pattern - defines algorithm structure
   * @param tokenAddress - Token contract address
   * @returns Promise with token metadata or null if failed
   */
  async enrich(tokenAddress: string): Promise<TokenMetadata | null> {
    try {
      // Pre-processing hook
      await this.beforeEnrich(tokenAddress)

      // Main enrichment logic (implemented by concrete strategies)
      const metadata = await this.doEnrich(tokenAddress)

      if (!metadata) {
        return null
      }

      // Post-processing hook
      const processedMetadata = await this.afterEnrich(metadata, tokenAddress)

      // Validation
      if (!this.isValidMetadata(processedMetadata)) {
        return null
      }

      return processedMetadata
    } catch (error) {
      await this.onError(error, tokenAddress)
      return null
    }
  }

  /**
   * Validates if the enriched metadata is complete and valid
   * Default implementation - can be overridden by concrete strategies
   * @param metadata - Token metadata to validate
   * @returns Boolean indicating if metadata is valid
   */
  isValidMetadata(metadata: TokenMetadata): boolean {
    return !!(
      metadata.name &&
      metadata.symbol &&
      metadata.decimals >= 0 &&
      metadata.decimals <= 255 &&
      metadata.totalSupply >= 0n &&
      metadata.tokenType &&
      metadata.tokenType !== 'UNKNOWN'
    )
  }

  // Abstract methods to be implemented by concrete strategies

  /**
   * Checks if this strategy can handle the given token
   * Must be implemented by concrete strategies
   * @param tokenAddress - Token contract address
   * @returns Promise with boolean indicating if strategy can handle token
   */
  abstract canHandle(tokenAddress: string): Promise<boolean>

  /**
   * Core enrichment logic
   * Must be implemented by concrete strategies
   * @param tokenAddress - Token contract address
   * @returns Promise with token metadata or null if failed
   */
  protected abstract doEnrich(tokenAddress: string): Promise<TokenMetadata | null>

  // Template method hooks - can be overridden by concrete strategies

  /**
   * Pre-processing hook called before enrichment
   * @param tokenAddress - Token contract address
   */
  protected async beforeEnrich(tokenAddress: string): Promise<void> {
    // Default implementation - do nothing
  }

  /**
   * Post-processing hook called after enrichment
   * @param metadata - Enriched metadata
   * @param tokenAddress - Token contract address
   * @returns Processed metadata
   */
  protected async afterEnrich(metadata: TokenMetadata, tokenAddress: string): Promise<TokenMetadata> {
    // Default implementation - return metadata as-is
    return metadata
  }

  /**
   * Error handling hook
   * @param error - Error that occurred
   * @param tokenAddress - Token contract address
   */
  protected async onError(error: any, tokenAddress: string): Promise<void> {
    // Default implementation - log error
    console.error(`Strategy ${this.name} failed for token ${tokenAddress}:`, error)
  }

  // Utility methods for concrete strategies

  /**
   * Normalizes token address to lowercase
   * @param address - Token address
   * @returns Normalized address
   */
  protected normalizeAddress(address: string): string {
    return address.toLowerCase()
  }

  /**
   * Validates if address is a valid Ethereum address
   * @param address - Address to validate
   * @returns Boolean indicating if address is valid
   */
  protected isValidAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address)
  }

  /**
   * Truncates string to maximum length
   * @param str - String to truncate
   * @param maxLength - Maximum length
   * @returns Truncated string
   */
  protected truncateString(str: string, maxLength: number): string {
    return str.length > maxLength ? str.substring(0, maxLength) : str
  }
} 