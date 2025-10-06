import { ClickHouseService } from './ClickHouseService';
import { StorageConfig } from '../../config/AppConfig';
import { logger } from '../../utils/logger';

interface ColdTransactionRecord {
  transaction_hash: string;
  block_number: number;
  block_timestamp: string;
  transaction_index: number;
  from_address: string;
  to_address?: string | null;
  value: string;
  gas: string;
  gas_price: string;
  gas_used: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  input?: string | null;
  status?: number | null;
  nonce: string;
  type?: number | null;
  method_id?: string | null;
  method_name?: string | null;
  is_contract_creation: number;
  is_contract_interaction: number;
  contract_address?: string | null;
}

interface ColdLogRecord {
  block_number: number;
  block_timestamp: string;
  transaction_hash: string;
  log_index: number;
  address: string;
  topics: string[];
  data: string;
}

export class ColdStorageQueryService {
  private readonly tables = this.storageConfig.clickHouse.tables;

  constructor(
    private readonly clickHouseService: ClickHouseService,
    private readonly storageConfig: StorageConfig,
  ) {}

  public async getTransactions(limit: number, offset: number): Promise<{
    transactions: any[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      const rows = await this.clickHouseService.query<ColdTransactionRecord>(
        `SELECT
          transaction_hash,
          block_number,
          block_timestamp,
          transaction_index,
          from_address,
          to_address,
          value,
          gas,
          gas_price,
          gas_used,
          status,
          is_contract_interaction,
          is_contract_creation
        FROM ${this.tables.transactions}
        ORDER BY block_timestamp DESC, transaction_index DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt64}`,
        { limit, offset }
      );

      const totalResult = await this.clickHouseService.query<{ total: number }>(
        `SELECT count() AS total FROM ${this.tables.transactions}`
      );

      const total = totalResult[0]?.total ?? rows.length;

      const transactions = rows.map(row => ({
        hash: row.transaction_hash,
        blockNumber: Number(row.block_number),
        fromAddress: row.from_address,
        toAddress: row.to_address,
        value: row.value,
        gasUsed: row.gas_used,
        gasPrice: row.gas_price,
        timestamp: new Date(row.block_timestamp),
        status: row.status,
        isContractInteraction: Boolean(row.is_contract_interaction),
        isContractCreation: Boolean(row.is_contract_creation),
      }));

      return {
        transactions,
        total,
        hasMore: offset + limit < total,
      };
    } catch (error) {
      logger.error('Failed to query cold storage transactions', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  public async getTransactionByHash(hash: string): Promise<{
    transaction: any;
    logs: any[];
  } | null> {
    try {
      const rows = await this.clickHouseService.query<ColdTransactionRecord>(
        `SELECT
          transaction_hash,
          block_number,
          block_timestamp,
          transaction_index,
          from_address,
          to_address,
          value,
          gas,
          gas_price,
          gas_used,
          max_fee_per_gas,
          max_priority_fee_per_gas,
          input,
          status,
          nonce,
          type,
          method_id,
          method_name,
          is_contract_creation,
          is_contract_interaction,
          contract_address
        FROM ${this.tables.transactions}
        WHERE transaction_hash = {hash:String}
        LIMIT 1`,
        { hash }
      );

      if (rows.length === 0) {
        return null;
      }

      const record = rows[0];

      const logs = await this.clickHouseService.query<ColdLogRecord>(
        `SELECT
          block_number,
          block_timestamp,
          transaction_hash,
          log_index,
          address,
          topics,
          data
        FROM ${this.tables.logs}
        WHERE transaction_hash = {hash:String}
        ORDER BY log_index ASC`,
        { hash }
      );

      const transaction = {
        hash: record.transaction_hash,
        blockNumber: Number(record.block_number),
        blockTimestamp: new Date(record.block_timestamp),
        transactionIndex: record.transaction_index,
        fromAddress: record.from_address,
        toAddress: record.to_address,
        value: record.value,
        gas: record.gas,
        gasPrice: record.gas_price,
        gasUsed: record.gas_used,
        maxFeePerGas: record.max_fee_per_gas,
        maxPriorityFeePerGas: record.max_priority_fee_per_gas,
        input: record.input,
        status: record.status,
        nonce: record.nonce,
        type: record.type,
        methodId: record.method_id,
        methodName: record.method_name,
        isContractCreation: Boolean(record.is_contract_creation),
        isContractInteraction: Boolean(record.is_contract_interaction),
        contractAddress: record.contract_address,
      };

      const formattedLogs = logs.map(log => ({
        blockNumber: Number(log.block_number),
        blockTimestamp: new Date(log.block_timestamp),
        transactionHash: log.transaction_hash,
        logIndex: log.log_index,
        address: log.address,
        topics: log.topics,
        data: log.data,
      }));

      return {
        transaction,
        logs: formattedLogs,
      };
    } catch (error) {
      logger.error('Failed to query cold storage transaction by hash', {
        hash,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
}
