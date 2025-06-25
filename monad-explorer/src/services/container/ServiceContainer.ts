import { 
  ITokenMetadataService, 
  IInternalTransactionService, 
  ICacheService, 
  IBlockchainProvider,
  ITokenRepository,
  IInternalTransactionRepository 
} from '../interfaces'
import { ServiceConfig } from '../types'

/**
 * Dependency Injection Container
 * Following Dependency Inversion Principle - depends on abstractions, not concretions
 * Following Single Responsibility Principle - only manages dependencies
 */
export class ServiceContainer {
  private readonly services = new Map<string, any>()
  private readonly config: ServiceConfig

  constructor(config: ServiceConfig) {
    this.config = config
  }

  /**
   * Registers a service implementation
   * @param token - Service identifier token
   * @param implementation - Service implementation
   */
  register<T>(token: string, implementation: T): void {
    this.services.set(token, implementation)
  }

  /**
   * Registers a service factory
   * @param token - Service identifier token
   * @param factory - Factory function that creates the service
   */
  registerFactory<T>(token: string, factory: (container: ServiceContainer) => T): void {
    this.services.set(token, { factory, isFactory: true })
  }

  /**
   * Resolves a service by token
   * @param token - Service identifier token
   * @returns Service instance
   */
  resolve<T>(token: string): T {
    const service = this.services.get(token)
    
    if (!service) {
      throw new Error(`Service not registered: ${token}`)
    }

    if (service.isFactory) {
      return service.factory(this)
    }

    return service
  }

  /**
   * Gets the service configuration
   * @returns Service configuration
   */
  getConfig(): ServiceConfig {
    return this.config
  }

  /**
   * Checks if a service is registered
   * @param token - Service identifier token
   * @returns Boolean indicating if service is registered
   */
  hasService(token: string): boolean {
    return this.services.has(token)
  }

  /**
   * Clears all registered services
   */
  clear(): void {
    this.services.clear()
  }
}

// Service tokens for type-safe dependency injection
export const SERVICE_TOKENS = {
  TOKEN_METADATA_SERVICE: 'TokenMetadataService',
  INTERNAL_TRANSACTION_SERVICE: 'InternalTransactionService',
  CACHE_SERVICE: 'CacheService',
  BLOCKCHAIN_PROVIDER: 'BlockchainProvider',
  TOKEN_REPOSITORY: 'TokenRepository',
  INTERNAL_TRANSACTION_REPOSITORY: 'InternalTransactionRepository'
} as const

// Type definitions for service resolution
export interface ServiceRegistry {
  [SERVICE_TOKENS.TOKEN_METADATA_SERVICE]: ITokenMetadataService
  [SERVICE_TOKENS.INTERNAL_TRANSACTION_SERVICE]: IInternalTransactionService
  [SERVICE_TOKENS.CACHE_SERVICE]: ICacheService
  [SERVICE_TOKENS.BLOCKCHAIN_PROVIDER]: IBlockchainProvider
  [SERVICE_TOKENS.TOKEN_REPOSITORY]: ITokenRepository
  [SERVICE_TOKENS.INTERNAL_TRANSACTION_REPOSITORY]: IInternalTransactionRepository
} 