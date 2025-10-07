import { DataSource, EntityManager } from 'typeorm';
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

interface BlockCandidate {
  id: string;
  number: string;
  timestamp: Date;
}

export class HotStoragePruner {
  private dataSource: DataSource | null = null;
  private static readonly CHUNK_SIZE = 500;
  private static readonly ISOLATION_LEVEL = 'READ COMMITTED';
  // Prevent connection pool exhaustion with large batches
  private static readonly MAX_TRANSACTION_DURATION_MS = 60000; // 1 minute
  private isProcessing = false;

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
        max: 20, // Increased for large batches
        min: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 20000, // Increased timeout
        // PostgreSQL-specific optimizations
        statement_timeout: 300000, // 5 minutes for large batches
        query_timeout: 300000,
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

    // Prevent concurrent execution that could exhaust connection pool
    if (this.isProcessing) {
      logger.warn('Pruning already in progress, skipping this batch');
      return {
        cutoffTimestamp: new Date(),
        blocksConsidered: 0,
        blocksDeleted: 0,
        transactionsDeleted: 0,
        logsDeleted: 0,
        dryRun: false,
      };
    }

    this.isProcessing = true;

    try {
      const { hotRetentionDays, pruner } = this.storageConfig;
      const retentionMs = hotRetentionDays * 60 * 60 * 1000;
      const safetyBufferMs = pruner.safetyBufferHours * 60 * 60 * 1000;
      const cutoff = new Date(Date.now() - retentionMs - safetyBufferMs);

      // Execute entire pruning operation within a single transaction
      // This ensures ACID compliance and maintains lock consistency
      const result = await this.dataSource.transaction(
        HotStoragePruner.ISOLATION_LEVEL,
        async (manager) => {
        // Phase 1: Select and lock candidate blocks using SKIP LOCKED
        const candidates = await this.selectCandidateBlocks(
          manager,
          cutoff,
          pruner.batchSize
        );

        if (candidates.length === 0) {
          logger.info('Hot storage pruning skipped - no eligible blocks', {
            cutoff,
            batchSize: pruner.batchSize,
          });
          return {
            candidates: [],
            candidateBlockRange: null,
            blocksDeleted: 0,
            transactionsDeleted: 0,
            logsDeleted: 0,
          };
        }

        const candidateBlockRange = {
          start: Number(candidates[0].number),
          end: Number(candidates[candidates.length - 1].number),
        };

        logger.info('Hot storage pruning candidate summary', {
          cutoff,
          batchSize: pruner.batchSize,
          candidateCount: candidates.length,
          candidateBlockRange,
        });

        if (pruner.dryRun) {
          const txCount = await this.countTransactions(manager, candidates);
          logger.info('Hot storage pruner dry-run summary', {
            cutoff,
            blocksMatched: candidates.length,
            transactionsMatched: txCount,
          });
          return {
            candidates,
            candidateBlockRange,
            blocksDeleted: 0,
            transactionsDeleted: 0,
            logsDeleted: 0,
          };
        }

        // Phase 2: Cascade delete in correct order (logs -> transactions -> blocks)
        const deletionResult = await this.executeCascadeDelete(
          manager,
          candidates
        );

        return {
          candidates,
          candidateBlockRange,
          ...deletionResult,
        };
        }
      );

      if (result.candidates.length === 0) {
        return {
          cutoffTimestamp: cutoff,
          blocksConsidered: 0,
          blocksDeleted: 0,
          transactionsDeleted: 0,
          logsDeleted: 0,
          dryRun: pruner.dryRun,
        };
      }

      logger.info('Hot storage pruning batch completed', {
        cutoff,
        blocksConsidered: result.candidates.length,
        blocksDeleted: result.blocksDeleted,
        transactionsDeleted: result.transactionsDeleted,
        logsDeleted: result.logsDeleted,
        candidateBlockRange: result.candidateBlockRange,
      });

      return {
        cutoffTimestamp: cutoff,
        blocksConsidered: result.candidates.length,
        blocksDeleted: result.blocksDeleted,
        transactionsDeleted: result.transactionsDeleted,
        logsDeleted: result.logsDeleted,
        dryRun: false,
      };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Selects candidate blocks using FOR UPDATE SKIP LOCKED
   * This prevents race conditions when multiple pruner instances run concurrently
   */
  private async selectCandidateBlocks(
    manager: EntityManager,
    cutoff: Date,
    batchSize: number
  ): Promise<BlockCandidate[]> {
    // Use index on timestamp for efficient candidate selection
    const candidates = await manager.query<BlockCandidate[]>(
      `SELECT id, number, timestamp
       FROM block
       WHERE timestamp < $1
       ORDER BY timestamp ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [cutoff, batchSize]
    );

    return candidates;
  }

  /**
   * Counts transactions for dry-run mode
   */
  private async countTransactions(
    manager: EntityManager,
    candidates: BlockCandidate[]
  ): Promise<number> {
    if (candidates.length === 0) return 0;

    const blockIds = candidates.map((c) => c.id);
    const result = await manager.query<{ count: string }[]>(
      `SELECT COUNT(*) as count
       FROM transaction
       WHERE block_id = ANY($1::text[])`,
      [blockIds]
    );

    return parseInt(result[0]?.count || '0', 10);
  }

  /**
   * Executes cascade deletion with optimized batch processing
   * Uses CTE (Common Table Expression) for efficient single-pass deletion
   * Order: logs -> transactions -> blocks (child to parent)
   */
  private async executeCascadeDelete(
    manager: EntityManager,
    candidates: BlockCandidate[]
  ): Promise<{
    blocksDeleted: number;
    transactionsDeleted: number;
    logsDeleted: number;
  }> {
    const blockIds = candidates.map((c) => c.id);
    let logsDeleted = 0;
    let transactionsDeleted = 0;
    let blocksDeleted = 0;

    // Process in chunks to avoid parameter limits and reduce lock contention
    for (let i = 0; i < blockIds.length; i += HotStoragePruner.CHUNK_SIZE) {
      const chunk = blockIds.slice(i, i + HotStoragePruner.CHUNK_SIZE);

      // Use CTE for efficient cascade deletion in minimal queries
      // This reduces transaction duration significantly

      // Step 1: Delete logs and transactions in a single optimized query
      const result = await manager.query(
        `WITH deleted_logs AS (
           DELETE FROM log
           WHERE transaction_id IN (
             SELECT id FROM transaction WHERE block_id = ANY($1::text[])
           )
           RETURNING 1
         ),
         deleted_txs AS (
           DELETE FROM transaction WHERE block_id = ANY($1::text[])
           RETURNING 1
         )
         SELECT
           (SELECT COUNT(*) FROM deleted_logs) as logs,
           (SELECT COUNT(*) FROM deleted_txs) as txs`,
        [chunk]
      );

      logsDeleted += parseInt(result[0]?.logs || '0', 10);
      transactionsDeleted += parseInt(result[0]?.txs || '0', 10);

      // Step 2: Delete blocks (now safe as children are removed)
      const blockResult = await manager.query(
        `DELETE FROM block WHERE id = ANY($1::text[])`,
        [chunk]
      );
      blocksDeleted += blockResult[1] || 0;
    }

    return {
      logsDeleted,
      transactionsDeleted,
      blocksDeleted,
    };
  }
}
