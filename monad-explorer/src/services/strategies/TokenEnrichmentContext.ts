import { ITokenEnrichmentStrategy } from './ITokenEnrichmentStrategy'
import { TokenMetadata } from '../types'

/**
 * Context class for managing token enrichment strategies
 * Following Strategy Pattern and Single Responsibility Principle
 * Following Open/Closed Principle - new strategies can be added without modifying this class
 */
export class TokenEnrichmentContext {
  private readonly strategies: ITokenEnrichmentStrategy[] = []

  /**
   * Registers a new enrichment strategy
   * @param strategy - Token enrichment strategy to register
   */
  addStrategy(strategy: ITokenEnrichmentStrategy): void {
    // Insert strategy in priority order (highest priority first)
    const insertIndex = this.strategies.findIndex(s => s.getPriority() < strategy.getPriority())
    
    if (insertIndex === -1) {
      this.strategies.push(strategy)
    } else {
      this.strategies.splice(insertIndex, 0, strategy)
    }
  }

  /**
   * Removes a strategy by name
   * @param strategyName - Name of strategy to remove
   * @returns Boolean indicating if strategy was removed
   */
  removeStrategy(strategyName: string): boolean {
    const index = this.strategies.findIndex(s => s.getName() === strategyName)
    
    if (index === -1) {
      return false
    }

    this.strategies.splice(index, 1)
    return true
  }

  /**
   * Enriches token metadata using the best available strategy
   * @param tokenAddress - Token contract address
   * @returns Promise with token metadata or null if no strategy could handle it
   */
  async enrichToken(tokenAddress: string): Promise<TokenMetadata | null> {
    // Try strategies in priority order
    for (const strategy of this.strategies) {
      try {
        const canHandle = await strategy.canHandle(tokenAddress)
        
        if (canHandle) {
          const metadata = await strategy.enrich(tokenAddress)
          
          if (metadata && strategy.isValidMetadata(metadata)) {
            return metadata
          }
        }
      } catch (error) {
        // Log error but continue with next strategy
        console.warn(`Strategy ${strategy.getName()} failed for token ${tokenAddress}:`, error)
        continue
      }
    }

    // No strategy could handle this token
    return null
  }

  /**
   * Gets all registered strategies
   * @returns Array of registered strategies
   */
  getStrategies(): ITokenEnrichmentStrategy[] {
    return [...this.strategies] // Return copy to prevent external modification
  }

  /**
   * Gets strategy by name
   * @param name - Strategy name
   * @returns Strategy instance or undefined if not found
   */
  getStrategy(name: string): ITokenEnrichmentStrategy | undefined {
    return this.strategies.find(s => s.getName() === name)
  }

  /**
   * Checks if any strategy can handle the given token
   * @param tokenAddress - Token contract address
   * @returns Promise with boolean indicating if token can be enriched
   */
  async canEnrichToken(tokenAddress: string): Promise<boolean> {
    for (const strategy of this.strategies) {
      try {
        if (await strategy.canHandle(tokenAddress)) {
          return true
        }
      } catch (error) {
        // Continue checking other strategies
        continue
      }
    }

    return false
  }

  /**
   * Gets the count of registered strategies
   * @returns Number of registered strategies
   */
  getStrategyCount(): number {
    return this.strategies.length
  }
} 