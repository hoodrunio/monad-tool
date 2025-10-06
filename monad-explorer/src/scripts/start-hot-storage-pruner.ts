import 'dotenv/config';
import { ApplicationBootstrapper } from '../bootstrap/ApplicationBootstrapper';
import { appConfig } from '../config/AppConfig';
import { HotStoragePruner } from '../services/pruning/HotStoragePruner';
import { logger } from '../utils/logger';

class HotStoragePrunerApp {
  private readonly bootstrapper = new ApplicationBootstrapper();
  private pruner?: HotStoragePruner;
  private intervalHandle: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  public async start(): Promise<void> {
    try {
      logger.info('Starting Hot Storage Pruner...');
      await this.bootstrapper.initialize();

      const config = appConfig.getConfig();
      if (!config.storage.enableHotPruning) {
        logger.warn('Hot storage pruning is disabled. Enable ENABLE_HOT_PRUNING to run this worker.');
        await this.bootstrapper.shutdown();
        return;
      }

      this.pruner = new HotStoragePruner(config.storage);
      await this.pruner.initialize();

      this.setupShutdownHandlers();
      this.startKeepAlive();

      await this.executePrune();
      this.scheduleNextRun(config.storage.pruner.runIntervalMinutes);

      logger.info('Hot Storage Pruner is running', {
        intervalMinutes: config.storage.pruner.runIntervalMinutes,
        batchSize: config.storage.pruner.batchSize,
        dryRun: config.storage.pruner.dryRun,
        retentionDays: config.storage.hotRetentionDays,
      });
    } catch (error) {
      logger.error('Failed to start Hot Storage Pruner', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      await this.shutdown(1);
    }
  }

  private scheduleNextRun(intervalMinutes: number): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    this.intervalHandle = setInterval(() => {
      void this.executePrune();
    }, intervalMs);
  }

  private async executePrune(): Promise<void> {
    if (!this.pruner || this.shuttingDown) {
      return;
    }

    try {
      const result = await this.pruner.pruneBatch();
      logger.info('Hot storage prune batch complete', result);
    } catch (error) {
      logger.error('Hot storage prune batch failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private setupShutdownHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
    signals.forEach(signal => {
      process.on(signal, async () => {
        logger.info(`Received ${signal}, shutting down Hot Storage Pruner...`);
        await this.shutdown(0);
      });
    });

    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception in Hot Storage Pruner', {
        error: error.message,
        stack: error.stack,
      });
      await this.shutdown(1);
    });

    process.on('unhandledRejection', async (reason) => {
      logger.error('Unhandled rejection in Hot Storage Pruner', {
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
      logger.debug('Hot Storage Pruner heartbeat');
    }, 60_000);
  }

  private stopTimers(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private async shutdown(exitCode: number): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    this.stopTimers();

    try {
      if (this.pruner) {
        await this.pruner.dispose();
      }

      await this.bootstrapper.shutdown();
      logger.info('Hot Storage Pruner shutdown complete');
    } catch (error) {
      logger.error('Error during Hot Storage Pruner shutdown', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      process.exit(exitCode);
    }
  }
}

new HotStoragePrunerApp().start();
