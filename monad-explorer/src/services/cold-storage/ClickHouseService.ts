import { createClient, ClickHouseClient } from '@clickhouse/client';
import { StorageConfig } from '../../config/AppConfig';
import { ColdStorageBatch, SerializedBlock, SerializedTransaction, SerializedLog } from '../../interfaces/storage/IStorageRouter';
import { logger } from '../../utils/logger';

export class ClickHouseService {
  private readonly client: ClickHouseClient;

  constructor(private readonly config: StorageConfig['clickHouse']) {
    this.client = createClient({
      host: this.config.url,
      username: this.config.username,
      password: this.config.password,
      database: this.config.database,
      compression: this.config.compression ? { response: true, request: true } : undefined,
      request_timeout: this.config.requestTimeoutMs,
    });
  }

  public async ping(): Promise<void> {
    await this.client.ping();
  }

  public async insertBatch(batch: ColdStorageBatch): Promise<void> {
    const insertedAt = this.formatDateTimeString(batch.producedAt);

    const blockRows = batch.blocks.map(block => this.mapBlockRow(batch.batchId, insertedAt, block));
    const transactionRows = batch.transactions.map(tx => this.mapTransactionRow(batch.batchId, insertedAt, tx));
    const logRows = batch.logs.map(log => this.mapLogRow(batch.batchId, insertedAt, log));

    if (!blockRows.length && !transactionRows.length && !logRows.length) {
      logger.info('Cold storage batch skipped - no rows to insert', {
        batchId: batch.batchId,
      });
      return;
    }

    await this.insertRows(this.config.tables.blocks, blockRows, 'blocks');
    await this.insertRows(this.config.tables.transactions, transactionRows, 'transactions');
    await this.insertRows(this.config.tables.logs, logRows, 'logs');

    logger.info('Cold storage batch inserted', {
      batchId: batch.batchId,
      blocksInserted: blockRows.length,
      transactionsInserted: transactionRows.length,
      logsInserted: logRows.length,
    });
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  public async dispose(): Promise<void> {
    await this.close();
  }

  public async query<T = Record<string, unknown>>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const result = await this.client.query({
      query,
      format: 'JSONEachRow',
      query_params: params,
    });

    return result.json<T>();
  }

  private mapBlockRow(batchId: string, insertedAt: string, block: SerializedBlock) {
    return {
      batch_id: batchId,
      ingested_at: insertedAt,
      block_number: block.number,
      block_hash: block.hash,
      parent_hash: block.parentHash,
      block_timestamp: this.formatDateTimeString(block.timestamp),
      size: block.size,
      gas_limit: block.gasLimit,
      gas_used: block.gasUsed,
      transaction_count: block.transactionCount,
      miner: block.miner,
      extra_data: block.extraData,
      base_fee_per_gas: block.baseFeePerGas,
    };
  }

  private mapTransactionRow(batchId: string, insertedAt: string, transaction: SerializedTransaction) {
    return {
      batch_id: batchId,
      ingested_at: insertedAt,
      block_id: transaction.blockId,
      block_number: transaction.blockNumber,
      block_timestamp: this.formatDateTimeString(transaction.blockTimestamp),
      transaction_hash: transaction.hash,
      transaction_index: transaction.transactionIndex,
      from_address: transaction.fromAddress,
      to_address: transaction.toAddress,
      value: transaction.value,
      gas: transaction.gas,
      gas_price: transaction.gasPrice,
      gas_used: transaction.gasUsed,
      max_fee_per_gas: transaction.maxFeePerGas,
      max_priority_fee_per_gas: transaction.maxPriorityFeePerGas,
      input: transaction.input,
      status: transaction.status,
      nonce: transaction.nonce,
      type: transaction.type,
      method_id: transaction.methodId,
      method_name: transaction.methodName,
      is_contract_creation: transaction.isContractCreation ? 1 : 0,
      is_contract_interaction: transaction.isContractInteraction ? 1 : 0,
      contract_address: transaction.contractAddress,
    };
  }

  private mapLogRow(batchId: string, insertedAt: string, log: SerializedLog) {
    return {
      batch_id: batchId,
      ingested_at: insertedAt,
      block_number: log.blockNumber,
      block_timestamp: this.formatDateTimeString(log.blockTimestamp),
      transaction_hash: log.transactionHash,
      log_index: log.logIndex,
      address: log.address,
      topics: log.topics,
      data: log.data,
    };
  }

  private async insertRows<T>(table: string, rows: T[], label: string): Promise<void> {
    if (!rows.length) {
      return;
    }

    const chunkSize = Math.max(1, this.config.maxInsertBatchSize);

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      try {
        await this.client.insert({
          table,
          values: chunk,
          format: 'JSONEachRow',
        });
        logger.debug('Cold storage chunk inserted', {
          table,
          label,
          chunkSize: chunk.length,
        });
      } catch (error) {
        logger.error('Failed to insert rows into ClickHouse', {
          table,
          chunkSize: chunk.length,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }
  }

  private formatDateTimeString(value: string | null | undefined): string {
    if (!value) {
      return '1970-01-01 00:00:00';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      const normalized = value.replace('T', ' ').substring(0, 19);
      return normalized;
    }

    const iso = date.toISOString();
    return iso.replace('T', ' ').substring(0, 19);
  }
}
