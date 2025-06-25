// Core interfaces - abstractions that define contracts
export * from './interfaces'

// Types and configurations
export * from './types'
export * from './config'

// Dependency Injection Container
export { ServiceContainer, SERVICE_TOKENS } from './container/ServiceContainer'
export { ServiceFactory, createServiceFactory } from './factory/ServiceFactory'

// Strategy Pattern implementations
export { ITokenEnrichmentStrategy } from './strategies/ITokenEnrichmentStrategy'
export { BaseTokenEnrichmentStrategy } from './strategies/BaseTokenEnrichmentStrategy'
export { TokenEnrichmentContext } from './strategies/TokenEnrichmentContext'

// This index file follows SOLID principles:
// - Single Responsibility: Only exports services modules
// - Open/Closed: New modules can be added without modifying existing exports
// - Liskov Substitution: All exports follow their interface contracts
// - Interface Segregation: Exports are organized by responsibility
// - Dependency Inversion: Exports abstractions (interfaces) first, then implementations 