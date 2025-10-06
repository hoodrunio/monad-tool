import 'dotenv/config';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
import type { ApplicationBootstrapper } from '../bootstrap/ApplicationBootstrapper';
import type { ColdStorageIngestionWorker } from '../services/cold-storage/ColdStorageIngestionWorker';

dotenv.config();

class ColdStorageWorkerApp {
  private bootstrapper: ApplicationBootstrapper | null = null;
  private worker: ColdStorageIngestionWorker | null = null;
  private isShuttingDown = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  public async start(): Promise<void> {
    try {
      logger.info('Starting Cold Storage Ingestion Worker...');
      const redisHost = process.env.INTERNAL_REDIS_HOST || process.env.REDIS_HOST;
      const redisPort = process.env.INTERNAL_REDIS_PORT || process.env.REDIS_PORT;
      if (redisHost) {
        process.env.REDIS_HOST = redisHost;
      }
      if (redisPort) {
        process.env.REDIS_PORT = redisPort;
      }

      // Initialize after env overrides so config picks up correct values
      const { ApplicationBootstrapper } = await import('../bootstrap/ApplicationBootstrapper');
      const { ColdStorageIngestionWorker } = await import('../services/cold-storage/ColdStorageIngestionWorker');
      this.bootstrapper = new ApplicationBootstrapper();
      this.worker = new ColdStorageIngestionWorker();

      await this.bootstrapper.initialize();
      await this.worker.start();
      this.setupShutdownHandlers();
      this.startKeepAlive();
      logger.info('Cold Storage Ingestion Worker is running');
    } catch (error) {
      logger.error('Failed to start Cold Storage Ingestion Worker', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      await this.shutdown(1);
    }
  }

  private setupShutdownHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

    signals.forEach(signal => {
      process.on(signal, async () => {
        logger.info(`Received ${signal}, shutting down Cold Storage Ingestion Worker...`);
        await this.shutdown(0);
      });
    });

    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception in Cold Storage Ingestion Worker', {
        error: error.message,
        stack: error.stack,
      });
      await this.shutdown(1);
    });

    process.on('unhandledRejection', async (reason) => {
      logger.error('Unhandled rejection in Cold Storage Ingestion Worker', {
        reason: reason instanceof Error ? reason.message : String(reason),
      });
      await this.shutdown(1);
    });
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) {
      return;
    }

    this.keepAliveTimer = setInterval(() => {
      logger.debug('Cold Storage Ingestion Worker heartbeat');
    }, 60_000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private async shutdown(exitCode: number): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    try {
      this.stopKeepAlive();
      if (this.worker) {
        await this.worker.stop();
      }
      if (this.bootstrapper) {
        await this.bootstrapper.shutdown();
      }
      logger.info('Cold Storage Ingestion Worker shutdown complete');
    } catch (error) {
      logger.error('Error during Cold Storage Ingestion Worker shutdown', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      process.exit(exitCode);
    }
  }
}

new ColdStorageWorkerApp().start();
