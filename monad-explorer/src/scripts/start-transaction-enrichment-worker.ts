#!/usr/bin/env node

import { config } from 'dotenv';
import { ApplicationBootstrapper } from '../bootstrap/ApplicationBootstrapper';
import { TransactionEnrichmentWorker } from '../services/transaction/TransactionEnrichmentWorker';
import { logger } from '../utils/logger';

// Load environment variables
config();

/**
 * Transaction Enrichment Worker Startup Script
 * 
 * Starts the async transaction enrichment worker that processes
 * heavy transaction computations in the background to improve
 * block processing performance.
 */
async function startTransactionEnrichmentWorker(): Promise<void> {
  logger.info('Starting Transaction Enrichment Worker...');

  try {
    // Initialize application dependencies
    const bootstrapper = new ApplicationBootstrapper();
    await bootstrapper.initialize();

    // Create and start the transaction enrichment worker
    const worker = new TransactionEnrichmentWorker();
    await worker.start();

    logger.info('Transaction Enrichment Worker started successfully');

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Shutting down Transaction Enrichment Worker...`);
      
      try {
        await worker.stop();
        await bootstrapper.shutdown();
        logger.info('Transaction Enrichment Worker shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        process.exit(1);
      }
    };

    // Listen for shutdown signals
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGQUIT', () => shutdown('SIGQUIT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception in Transaction Enrichment Worker', {
        error: error.message,
        stack: error.stack,
      });
      process.exit(1);
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection in Transaction Enrichment Worker', {
        reason: reason instanceof Error ? reason.message : String(reason),
        promise: String(promise),
      });
      process.exit(1);
    });

    // Keep the process alive
    process.stdin.resume();

  } catch (error) {
    logger.error('Failed to start Transaction Enrichment Worker', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  }
}

// Start the worker
startTransactionEnrichmentWorker().catch((error) => {
  logger.error('Fatal error starting Transaction Enrichment Worker', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exit(1);
});