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
      extra: {
        max: 10,
        min: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      },
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

    const retentionMs = hotRetentionDays * 60 * 60 * 1000;
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

    const candidateBlockRange = candidateBlocks.length
      ? {
          start: Number(candidateBlocks[0].number ?? 0),
          end: Number(candidateBlocks[candidateBlocks.length - 1].number ?? 0),
        }
      : null;

    const blockIds = candidateBlocks.map(block => block.id);

    if (candidateBlocks.length === 0) {
      logger.info('Hot storage pruning skipped - no eligible blocks', {
        cutoff,
        batchSize: pruner.batchSize,
        hotBlockWindow: this.storageConfig.hotBlockWindow,
      });
      return {
        cutoffTimestamp: cutoff,
        blocksConsidered: 0,
        blocksDeleted: 0,
        transactionsDeleted: 0,
        logsDeleted: 0,
        dryRun: pruner.dryRun,
      };
    }

    logger.info('Hot storage pruning candidate summary', {
      cutoff,
      batchSize: pruner.batchSize,
      candidateCount: candidateBlocks.length,
      candidateBlockRange,
    });

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

      // Create temporary table for efficient bulk operations
      await manager.query('CREATE TEMP TABLE IF NOT EXISTS temp_block_ids (id TEXT) ON COMMIT DROP');
      await manager.query('CREATE TEMP TABLE IF NOT EXISTS temp_tx_ids (id TEXT) ON COMMIT DROP');

      if (blockIds.length > 0) {
        // Insert block IDs in chunks to avoid parameter limits
        const blockChunkSize = 1000;
        for (let i = 0; i < blockIds.length; i += blockChunkSize) {
          const chunk = blockIds.slice(i, i + blockChunkSize);
          const values = chunk.map((_, idx) => `($${idx + 1})`).join(',');
          await manager.query(`INSERT INTO temp_block_ids (id) VALUES ${values}`, chunk);
        }
      }

      if (transactionIds.length > 0) {
        // Insert transaction IDs in chunks
        const txChunkSize = 1000;
        for (let i = 0; i < transactionIds.length; i += txChunkSize) {
          const chunk = transactionIds.slice(i, i + txChunkSize);
          const values = chunk.map((_, idx) => `($${idx + 1})`).join(',');
          await manager.query(`INSERT INTO temp_tx_ids (id) VALUES ${values}`, chunk);
        }

        // Delete logs using temp table join
        const logDeleteResult = await manager.query(
          'DELETE FROM log WHERE transaction_id IN (SELECT id FROM temp_tx_ids)'
        );
        logsDeleted = logDeleteResult[1] || 0;

        // Delete transactions using temp table join
        const txDeleteResult = await manager.query(
          'DELETE FROM transaction WHERE id IN (SELECT id FROM temp_tx_ids)'
        );
        transactionsDeleted = txDeleteResult[1] || 0;
      }

      if (blockIds.length > 0) {
        // Delete blocks using temp table join
        const blockDeleteResult = await manager.query(
          'DELETE FROM block WHERE id IN (SELECT id FROM temp_block_ids)'
        );
        blocksDeleted = blockDeleteResult[1] || 0;
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
      candidateBlockRange,
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
