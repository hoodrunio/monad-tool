import 'dotenv/config';
import { ApplicationBootstrapper } from '../bootstrap/ApplicationBootstrapper';
import { ColdStorageIngestionWorker } from '../services/cold-storage/ColdStorageIngestionWorker';
import { logger } from '../utils/logger';

class ColdStorageWorkerApp {
  private readonly bootstrapper = new ApplicationBootstrapper();
  private readonly worker = new ColdStorageIngestionWorker();
  private isShuttingDown = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  public async start(): Promise<void> {
    try {
      logger.info('Starting Cold Storage Ingestion Worker...');
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
      await this.worker.stop();
      await this.bootstrapper.shutdown();
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
