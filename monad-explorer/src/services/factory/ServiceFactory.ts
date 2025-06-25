import { ServiceContainer, SERVICE_TOKENS } from '../container/ServiceContainer'
import { ServiceConfig } from '../types'

/**
 * Service Factory for creating and configuring services
 * Following Factory Pattern and Open/Closed Principle
 * Following Single Responsibility Principle - only creates services
 */
export class ServiceFactory {
  private readonly container: ServiceContainer

  constructor(config: ServiceConfig) {
    this.container = new ServiceContainer(config)
    this.registerServices()
  }

  /**
   * Gets the configured service container
   * @returns Service container instance
   */
  getContainer(): ServiceContainer {
    return this.container
  }

  /**
   * Registers all services in the container
   * Private method following Open/Closed Principle - extending doesn't modify existing code
   */
  private registerServices(): void {
    // Register service factories to enable lazy loading and dependency injection
    
    this.container.registerFactory(
      SERVICE_TOKENS.CACHE_SERVICE,
      (container) => this.createCacheService(container)
    )

    this.container.registerFactory(
      SERVICE_TOKENS.BLOCKCHAIN_PROVIDER,
      (container) => this.createBlockchainProvider(container)
    )

    this.container.registerFactory(
      SERVICE_TOKENS.TOKEN_REPOSITORY,
      (container) => this.createTokenRepository(container)
    )

    this.container.registerFactory(
      SERVICE_TOKENS.INTERNAL_TRANSACTION_REPOSITORY,
      (container) => this.createInternalTransactionRepository(container)
    )

    this.container.registerFactory(
      SERVICE_TOKENS.TOKEN_METADATA_SERVICE,
      (container) => this.createTokenMetadataService(container)
    )

    this.container.registerFactory(
      SERVICE_TOKENS.INTERNAL_TRANSACTION_SERVICE,
      (container) => this.createInternalTransactionService(container)
    )
  }

  /**
   * Creates cache service instance
   * Following Factory Pattern - encapsulates object creation
   */
  private createCacheService(container: ServiceContainer): any {
    // Will be implemented with concrete CacheService
    throw new Error('CacheService implementation not yet available')
  }

  /**
   * Creates blockchain provider instance
   * Following Factory Pattern - encapsulates object creation
   */
  private createBlockchainProvider(container: ServiceContainer): any {
    // Will be implemented with concrete BlockchainProvider
    throw new Error('BlockchainProvider implementation not yet available')
  }

  /**
   * Creates token repository instance
   * Following Factory Pattern - encapsulates object creation
   */
  private createTokenRepository(container: ServiceContainer): any {
    // Will be implemented with concrete TokenRepository
    throw new Error('TokenRepository implementation not yet available')
  }

  /**
   * Creates internal transaction repository instance
   * Following Factory Pattern - encapsulates object creation
   */
  private createInternalTransactionRepository(container: ServiceContainer): any {
    // Will be implemented with concrete InternalTransactionRepository
    throw new Error('InternalTransactionRepository implementation not yet available')
  }

  /**
   * Creates token metadata service instance
   * Following Factory Pattern - encapsulates object creation with dependencies
   */
  private createTokenMetadataService(container: ServiceContainer): any {
    // Will be implemented with concrete TokenMetadataService
    // Dependencies: BlockchainProvider, CacheService, TokenRepository
    throw new Error('TokenMetadataService implementation not yet available')
  }

  /**
   * Creates internal transaction service instance
   * Following Factory Pattern - encapsulates object creation with dependencies
   */
  private createInternalTransactionService(container: ServiceContainer): any {
    // Will be implemented with concrete InternalTransactionService
    // Dependencies: BlockchainProvider, CacheService, InternalTransactionRepository
    throw new Error('InternalTransactionService implementation not yet available')
  }
}

/**
 * Creates a fully configured service factory
 * @param config - Service configuration
 * @returns Configured service factory
 */
export function createServiceFactory(config: ServiceConfig): ServiceFactory {
  return new ServiceFactory(config)
} 