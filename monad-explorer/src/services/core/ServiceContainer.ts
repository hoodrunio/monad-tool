import { logger } from '../../utils/logger';
import { AppConfig } from '../../config/AppConfig';

export type ServiceConstructor<T = unknown> = new (...args: unknown[]) => T;
export type ServiceFactory<T = unknown> = () => T | Promise<T>;
export type ServiceLifetime = 'singleton' | 'transient' | 'scoped';

export interface ServiceDescriptor<T = unknown> {
  name: string;
  lifetime: ServiceLifetime;
  constructor?: ServiceConstructor<T>;
  factory?: ServiceFactory<T>;
  instance?: T;
  dependencies: string[];
}

export interface ServiceRegistration<T = unknown> {
  as: (lifetime: ServiceLifetime) => ServiceRegistration<T>;
  withDependencies: (...deps: string[]) => ServiceRegistration<T>;
}

export class ServiceContainer {
  private static instance: ServiceContainer;
  private services = new Map<string, ServiceDescriptor>();
  private resolutionStack: string[] = [];
  private isInitialized = false;

  private constructor() {}

  public static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
    }
    return ServiceContainer.instance;
  }

  /**
   * Register a service by constructor
   */
  public register<T>(
    name: string,
    constructor: ServiceConstructor<T>
  ): ServiceRegistration<T> {
    const descriptor: ServiceDescriptor<T> = {
      name,
      lifetime: 'singleton',
      constructor,
      dependencies: [],
    };

    this.services.set(name, descriptor);

    const registration: ServiceRegistration<T> = {
      as: (lifetime: ServiceLifetime) => {
        descriptor.lifetime = lifetime;
        return registration;
      },
      withDependencies: (...deps: string[]) => {
        descriptor.dependencies = deps;
        return registration;
      },
    };

    return registration;
  }

  /**
   * Register a service by factory function
   */
  public registerFactory<T>(
    name: string,
    factory: ServiceFactory<T>
  ): ServiceRegistration<T> {
    const descriptor: ServiceDescriptor<T> = {
      name,
      lifetime: 'singleton',
      constructor: undefined,
      factory,
      dependencies: [],
    };

    this.services.set(name, descriptor);

    const registration: ServiceRegistration<T> = {
      as: (lifetime: ServiceLifetime) => {
        descriptor.lifetime = lifetime;
        return registration;
      },
      withDependencies: (...deps: string[]) => {
        descriptor.dependencies = deps;
        return registration;
      },
    };

    return registration;
  }

  /**
   * Register a service instance
   */
  public registerInstance<T>(name: string, instance: T): void {
    const descriptor: ServiceDescriptor<T> = {
      name,
      lifetime: 'singleton',
      constructor: undefined,
      factory: undefined,
      instance,
      dependencies: [],
    };

    this.services.set(name, descriptor);
  }

  /**
   * Resolve a service by name
   */
  public async resolve<T>(name: string): Promise<T> {
    if (!this.isInitialized) {
      throw new Error('Service container not initialized. Call initialize() first.');
    }

    return this.resolveService<T>(name);
  }

  /**
   * Internal resolve method for use during initialization
   */
  public async resolveInternal<T>(name: string): Promise<T> {
    return this.resolveService<T>(name);
  }

  /**
   * Resolve a service synchronously (for already instantiated services)
   */
  public resolveSync<T>(name: string): T {
    if (!this.isInitialized) {
      throw new Error('Service container not initialized. Call initialize() first.');
    }

    const descriptor = this.services.get(name);
    if (!descriptor) {
      throw new Error(`Service '${name}' not registered`);
    }

    if (!descriptor.instance) {
      throw new Error(`Service '${name}' not instantiated. Use resolve() for async resolution.`);
    }

    return descriptor.instance as T;
  }

  /**
   * Initialize the container and resolve all singleton services
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Service container already initialized');
      return;
    }

    logger.info('Initializing service container...');

    // Validate service registrations
    this.validateServices();

    // Resolve all singleton services
    const singletonServices = Array.from(this.services.values())
      .filter(service => service.lifetime === 'singleton');

    for (const service of singletonServices) {
      try {
        await this.resolveService(service.name);
        logger.debug(`Initialized singleton service: ${service.name}`);
      } catch (error) {
        logger.error(`Failed to initialize service '${service.name}'`, {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        throw error;
      }
    }

    this.isInitialized = true;
    logger.info('Service container initialized successfully', {
      totalServices: this.services.size,
      singletonServices: singletonServices.length
    });
  }

  /**
   * Dispose of all services
   */
  public async dispose(): Promise<void> {
    logger.info('Disposing service container...');

    const disposableServices: Array<{ name: string; instance: unknown }> = [];

    for (const [name, descriptor] of this.services) {
      if (descriptor.instance && this.hasDisposeMethod(descriptor.instance)) {
        disposableServices.push({ name, instance: descriptor.instance });
      }
    }

    // Dispose services in reverse order of creation
    for (const { name, instance } of disposableServices.reverse()) {
      try {
        await (instance as { dispose(): Promise<void> }).dispose();
        logger.debug(`Disposed service: ${name}`);
      } catch (error) {
        logger.error(`Failed to dispose service '${name}'`, {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    this.services.clear();
    this.resolutionStack = [];
    this.isInitialized = false;

    logger.info('Service container disposed successfully');
  }

  /**
   * Get service registration info
   */
  public getServiceInfo(name: string): ServiceDescriptor | null {
    return this.services.get(name) || null;
  }

  /**
   * List all registered services
   */
  public listServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Check if service is registered
   */
  public hasService(name: string): boolean {
    return this.services.has(name);
  }

  private async resolveService<T>(name: string): Promise<T> {
    // Check for circular dependencies
    if (this.resolutionStack.includes(name)) {
      const cycle = [...this.resolutionStack, name].join(' -> ');
      throw new Error(`Circular dependency detected: ${cycle}`);
    }

    const descriptor = this.services.get(name);
    if (!descriptor) {
      throw new Error(`Service '${name}' not registered`);
    }

    // Return existing instance for singletons
    if (descriptor.lifetime === 'singleton' && descriptor.instance) {
      return descriptor.instance as T;
    }

    this.resolutionStack.push(name);

    try {
      // Resolve dependencies first
      const dependencies: unknown[] = [];
      if (descriptor.dependencies) {
        for (const depName of descriptor.dependencies) {
          const dependency = await this.resolveService(depName);
          dependencies.push(dependency);
        }
      }

      // Create instance
      let instance: T;
      if (descriptor.factory) {
        instance = await descriptor.factory() as T;
      } else if (descriptor.constructor) {
        instance = new descriptor.constructor(...dependencies) as T;
      } else {
        throw new Error(`Service '${name}' has no constructor or factory`);
      }

      // Store instance for singletons
      if (descriptor.lifetime === 'singleton') {
        descriptor.instance = instance;
      }

      return instance;
    } finally {
      this.resolutionStack.pop();
    }
  }

  private validateServices(): void {
    for (const [name, descriptor] of this.services) {
      // Check that all dependencies are registered
      if (descriptor.dependencies) {
        for (const depName of descriptor.dependencies) {
          if (!this.services.has(depName)) {
            throw new Error(
              `Service '${name}' depends on '${depName}' which is not registered`
            );
          }
        }
      }

      // Check that factory or constructor is provided
      if (!descriptor.factory && !descriptor.constructor && !descriptor.instance) {
        throw new Error(
          `Service '${name}' must have a factory, constructor, or instance`
        );
      }
    }
  }

  private hasDisposeMethod(instance: unknown): instance is { dispose(): Promise<void> } {
    return typeof instance === 'object' 
      && instance !== null 
      && 'dispose' in instance 
      && typeof (instance as { dispose: unknown }).dispose === 'function';
  }
}

// Export singleton instance
export const serviceContainer = ServiceContainer.getInstance();
export default serviceContainer; 