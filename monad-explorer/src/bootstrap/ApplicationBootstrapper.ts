import { serviceContainer } from '../services/core/ServiceContainer';
import { ServiceRegistration } from './ServiceRegistration';
import { logger } from '../utils/logger';

/**
 * Application Bootstrapper
 * Single Responsibility: Only handles application lifecycle management
 */
export class ApplicationBootstrapper {
  private isShuttingDown = false;
  private serviceRegistration: ServiceRegistration;

  constructor() {
    this.serviceRegistration = new ServiceRegistration();
  }

  /**
   * Initialize the application
   */
  public async initialize(): Promise<void> {
    try {
      logger.info('Starting Monad Explorer application initialization...');

      // Setup graceful shutdown handlers
      this.setupShutdownHandlers();

      // Register all services with dependency injection
      this.serviceRegistration.registerServices();

      // Initialize the service container
      await serviceContainer.initialize();

      logger.info('Application initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize application', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Shutdown the application gracefully
   */
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    logger.info('Shutting down application...');

    try {
      // Dispose of all services
      await serviceContainer.dispose();
      logger.info('Application shutdown completed successfully');
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Check if application is shutting down
   */
  public get isShutdownInProgress(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Setup graceful shutdown handlers for various signals
   */
  private setupShutdownHandlers(): void {
    const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const;
    
    signals.forEach(signal => {
      process.on(signal, async () => {
        logger.info(`Received ${signal}, initiating graceful shutdown...`);
        await this.shutdown();
        process.exit(0);
      });
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception detected', { 
        error: error.message, 
        stack: error.stack 
      });
      this.shutdown().finally(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled promise rejection detected', { 
        reason: reason instanceof Error ? reason.message : String(reason) 
      });
      this.shutdown().finally(() => process.exit(1));
    });

    logger.debug('Graceful shutdown handlers configured');
  }
} 