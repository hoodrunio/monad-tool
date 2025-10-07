import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { StorageConfig } from '../../config/AppConfig';
import { Block } from '../../model/generated/block.model';
import { Transaction } from '../../model/generated/transaction.model';
import { Log } from '../../model/generated/log.model';
import { logger } from '../../utils/logger';

export interface PruneResult {
  cutoffTimestamp: Date;
  blocksConsidered: number;
  blocksDeleted: number;
  transactionsDeleted: number;
  logsDeleted: number;
  dryRun: boolean;
}

export class HotStoragePruner {
  private dataSource: DataSource | null = null;

  constructor(private readonly storageConfig: StorageConfig) {}

  public async initialize(): Promise<void> {
    if (this.dataSource?.isInitialized) {
      return;
    }

    const dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASS || 'postgres',
      database: process.env.DB_NAME || 'squid',
      synchronize: false,
      logging: false,
      namingStrategy: new SnakeNamingStrategy(),
      entities: [Block, Transaction, Log],
    });

    await dataSource.initialize();
    this.dataSource = dataSource;

    logger.info('HotStoragePruner data source initialized');
  }

  public async dispose(): Promise<void> {
    if (this.dataSource?.isInitialized) {
      await this.dataSource.destroy();
      logger.info('HotStoragePruner data source closed');
    }
  }

  public async pruneBatch(): Promise<PruneResult> {
    if (!this.dataSource || !this.dataSource.isInitialized) {
      throw new Error('HotStoragePruner data source is not initialized');
    }

    const { hotRetentionDays, pruner } = this.storageConfig;

    const retentionMs = hotRetentionDays * 24 * 60 * 60 * 1000;
    const safetyBufferMs = pruner.safetyBufferHours * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - retentionMs - safetyBufferMs);

    const blockRepo = this.dataSource.getRepository(Block);
    const transactionRepo = this.dataSource.getRepository(Transaction);

    const candidateBlocks = await blockRepo
      .createQueryBuilder('block')
      .where('block.timestamp < :cutoff', { cutoff })
      .orderBy('block.timestamp', 'ASC')
      .limit(pruner.batchSize)
      .getMany();

    if (candidateBlocks.length === 0) {
      return {
        cutoffTimestamp: cutoff,
        blocksConsidered: 0,
        blocksDeleted: 0,
        transactionsDeleted: 0,
        logsDeleted: 0,
        dryRun: pruner.dryRun,
      };
    }

    const blockIds = candidateBlocks.map(block => block.id);

    const transactions = await transactionRepo
      .createQueryBuilder('tx')
      .innerJoin('tx.block', 'block')
      .select(['tx.id'])
      .where('block.id IN (:...blockIds)', { blockIds })
      .getMany();

    const transactionIds = transactions.map(tx => tx.id);

    if (pruner.dryRun) {
      logger.info('Hot storage pruner dry-run summary', {
        cutoff,
        blocksMatched: candidateBlocks.length,
        transactionsMatched: transactionIds.length,
      });

      return {
        cutoffTimestamp: cutoff,
        blocksConsidered: candidateBlocks.length,
        blocksDeleted: 0,
        transactionsDeleted: 0,
        logsDeleted: 0,
        dryRun: true,
      };
    }

    const result = await this.dataSource.transaction(async manager => {
      let logsDeleted = 0;
      let transactionsDeleted = 0;
      let blocksDeleted = 0;

      if (transactionIds.length > 0) {
        const logDeleteResult = await manager.query(
          'DELETE FROM log WHERE transaction_id = ANY($1::text[]) RETURNING id',
          [transactionIds]
        );
        logsDeleted = Array.isArray(logDeleteResult) ? logDeleteResult.length : 0;

        const txDeleteResult = await manager.query(
          'DELETE FROM transaction WHERE id = ANY($1::text[]) RETURNING id',
          [transactionIds]
        );
        transactionsDeleted = Array.isArray(txDeleteResult) ? txDeleteResult.length : 0;
      }

      if (blockIds.length > 0) {
        const blockDeleteResult = await manager.query(
          'DELETE FROM block WHERE id = ANY($1::text[]) RETURNING id',
          [blockIds]
        );
        blocksDeleted = Array.isArray(blockDeleteResult) ? blockDeleteResult.length : 0;
      }

      return {
        logsDeleted,
        transactionsDeleted,
        blocksDeleted,
      };
    });

    logger.info('Hot storage pruning batch completed', {
      cutoff,
      blocksConsidered: candidateBlocks.length,
      blocksDeleted: result.blocksDeleted,
      transactionsDeleted: result.transactionsDeleted,
      logsDeleted: result.logsDeleted,
    });

    return {
      cutoffTimestamp: cutoff,
      blocksConsidered: candidateBlocks.length,
      blocksDeleted: result.blocksDeleted,
      transactionsDeleted: result.transactionsDeleted,
      logsDeleted: result.logsDeleted,
      dryRun: false,
    };
  }
}
