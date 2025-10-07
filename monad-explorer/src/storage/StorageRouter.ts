import { StorageConfig } from '../config/AppConfig';
import { ProcessingResult } from '../processing/BlockProcessor';
import { IStorageRouter, StorageRoutingResult, HotStorageBatch, ColdStorageBatch, EntityBreakdown, SerializedBlock, SerializedTransaction, SerializedLog } from '../interfaces/storage/IStorageRouter';

export class StorageRouter implements IStorageRouter {
  private latestBlockNumber: number | null = null;
  private hotWindowStart: number | null = null;

  constructor(private readonly storageConfig: StorageConfig) {}

  public route(result: ProcessingResult): StorageRoutingResult {
    const fullHotBatch = this.buildHotBatch(result);
    this.updateLatestBlockNumber(fullHotBatch);

    const coldBatch = this.shouldProduceColdBatch()
      ? this.buildColdBatch(result, fullHotBatch)
      : null;

    const hotBatch = this.applyHotWindow(fullHotBatch);
    const hotBreakdown = this.getHotBreakdown(hotBatch);
    const coldBreakdown = coldBatch ? this.getColdBreakdown(coldBatch) : null;

    return {
      hot: hotBatch,
      cold: coldBatch,
      metadata: {
        routingMode: this.storageConfig.routingMode,
        hotEntityTotal: this.countEntities(hotBreakdown),
        coldEntityTotal: coldBreakdown ? this.countEntities(coldBreakdown) : 0,
        hotBreakdown,
        coldBreakdown,
        latestBlockNumber: this.latestBlockNumber,
        hotWindowStart: this.hotWindowStart,
      },
    };
  }

  private shouldProduceColdBatch(): boolean {
    if (!this.storageConfig.enableColdStorage) {
      return false;
    }

    return this.storageConfig.routingMode === 'dual-write' || this.storageConfig.routingMode === 'cold-primary';
  }

  private buildHotBatch(result: ProcessingResult): HotStorageBatch {
    return {
      blocks: [...result.blocks],
      transactions: [...result.transactions],
      logs: [...result.logs],
      accounts: Array.from(result.accounts.values()),
      methodSignatures: Array.from(result.methodSignatures.values()),
      tokens: [...result.tokens],
      contracts: [...result.contracts],
      discoveredContracts: [...result.discoveredContracts],
    };
  }

  private buildColdBatch(result: ProcessingResult, hotBatch: HotStorageBatch): ColdStorageBatch {
    const blockRange = this.extractBlockRange(result);

    return {
      batchId: this.createBatchId(blockRange),
      producedAt: new Date().toISOString(),
      blockRange,
      blocks: this.serializeBlocks(hotBatch.blocks),
      transactions: this.serializeTransactions(hotBatch.transactions),
      logs: this.serializeLogs(hotBatch.logs),
    };
  }

  private shouldApplyHotWindow(): boolean {
    if (!this.shouldProduceColdBatch()) {
      return false;
    }

    return this.storageConfig.hotBlockWindow > 0;
  }

  private updateLatestBlockNumber(batch: HotStorageBatch): void {
    if (batch.blocks.length === 0) {
      return;
    }

    const maxBlock = batch.blocks.reduce<number>((max, block) => {
      const blockNumber = Number(block.number ?? 0);
      return blockNumber > max ? blockNumber : max;
    }, this.latestBlockNumber ?? Number.MIN_SAFE_INTEGER);

    if (this.latestBlockNumber === null || maxBlock > this.latestBlockNumber) {
      this.latestBlockNumber = maxBlock;
    }
  }

  private applyHotWindow(batch: HotStorageBatch): HotStorageBatch {
    if (!this.shouldApplyHotWindow() || this.latestBlockNumber === null) {
      this.hotWindowStart = null;
      return batch;
    }

    const windowSize = this.storageConfig.hotBlockWindow;
    if (!windowSize || windowSize <= 0) {
      this.hotWindowStart = null;
      return batch;
    }

    const threshold = Math.max(0, this.latestBlockNumber - windowSize + 1);
    this.hotWindowStart = threshold;

    const hotBlocks = batch.blocks.filter(block => Number(block.number ?? 0) >= threshold);
    const hotBlockIds = new Set(hotBlocks.map(block => block.id));

    const hotTransactions = batch.transactions.filter(transaction => {
      const block = transaction.block;
      if (!block) {
        return false;
      }
      const blockNumber = Number(block.number ?? 0);
      return blockNumber >= threshold && hotBlockIds.has(block.id);
    });
    const hotTransactionIds = new Set(hotTransactions.map(tx => tx.id));

    const hotLogs = batch.logs.filter(log => {
      const transaction = log.transaction;
      if (!transaction) {
        return false;
      }
      return hotTransactionIds.has(transaction.id);
    });

    return {
      ...batch,
      blocks: hotBlocks,
      transactions: hotTransactions,
      logs: hotLogs,
    };
  }

  private extractBlockRange(result: ProcessingResult): { start: number; end: number } | null {
    if (result.blocks.length === 0) {
      return null;
    }

    const sortedBlocks = [...result.blocks].sort((a, b) => Number(a.number) - Number(b.number));
    const first = sortedBlocks[0];
    const last = sortedBlocks[sortedBlocks.length - 1];

    return {
      start: Number(first.number),
      end: Number(last.number),
    };
  }

  private createBatchId(range: { start: number; end: number } | null): string {
    const prefix = 'storage-batch';
    if (!range) {
      return `${prefix}-${Date.now()}`;
    }
    return `${prefix}-${range.start}-${range.end}-${Date.now()}`;
  }

  private getHotBreakdown(batch: HotStorageBatch): EntityBreakdown {
    return {
      blocks: batch.blocks.length,
      transactions: batch.transactions.length,
      logs: batch.logs.length,
      accounts: batch.accounts.length,
      methodSignatures: batch.methodSignatures.length,
      tokens: batch.tokens.length,
      contracts: batch.contracts.length,
      discoveredContracts: batch.discoveredContracts.length,
    };
  }

  private getColdBreakdown(batch: ColdStorageBatch): EntityBreakdown {
    return {
      blocks: batch.blocks.length,
      transactions: batch.transactions.length,
      logs: batch.logs.length,
      accounts: 0,
      methodSignatures: 0,
      tokens: 0,
      contracts: 0,
      discoveredContracts: 0,
    };
  }

  private countEntities(breakdown: EntityBreakdown): number {
    return breakdown.blocks +
      breakdown.transactions +
      breakdown.logs +
      breakdown.accounts +
      breakdown.methodSignatures +
      breakdown.tokens +
      breakdown.contracts +
      breakdown.discoveredContracts;
  }

  private serializeBlocks(blocks: HotStorageBatch['blocks']): SerializedBlock[] {
    return blocks.map(block => ({
      id: block.id,
      number: Number(block.number),
      hash: block.hash,
      parentHash: block.parentHash ?? null,
      timestamp: this.toDateTimeString(block.timestamp),
      size: this.toStringValue(block.size),
      gasLimit: this.toStringValue(block.gasLimit),
      gasUsed: this.toStringValue(block.gasUsed),
      transactionCount: Number(block.transactionCount ?? 0),
      miner: block.miner || null,
      extraData: block.extraData || null,
      baseFeePerGas: this.toStringValue(block.baseFeePerGas),
    }));
  }

  private serializeTransactions(transactions: HotStorageBatch['transactions']): SerializedTransaction[] {
    return transactions.map(transaction => ({
      hash: transaction.hash,
      blockId: transaction.block?.id ?? '',
      blockNumber: Number(transaction.block?.number ?? 0),
      blockTimestamp: this.toDateTimeString(transaction.timestamp ?? transaction.block?.timestamp),
      transactionIndex: Number(transaction.transactionIndex ?? 0),
      fromAddress: transaction.fromAddress,
      toAddress: transaction.toAddress || null,
      value: this.toStringValue(transaction.value),
      gas: this.toStringValue(transaction.gas),
      gasPrice: this.toStringValue(transaction.gasPrice),
      gasUsed: this.toStringValue(transaction.gasUsed),
      maxFeePerGas: this.toStringValue(transaction.maxFeePerGas),
      maxPriorityFeePerGas: this.toStringValue(transaction.maxPriorityFeePerGas),
      input: transaction.input || null,
      status: transaction.status ?? null,
      nonce: this.toStringValue(transaction.nonce),
      type: transaction.type ?? null,
      methodId: transaction.methodID ?? null,
      methodName: transaction.methodName ?? null,
      isContractCreation: Boolean(transaction.isContractCreation),
      isContractInteraction: Boolean(transaction.isContractInteraction),
      contractAddress: transaction.contractAddress || null,
    }));
  }

  private serializeLogs(logs: HotStorageBatch['logs']): SerializedLog[] {
    return logs.map(log => ({
      id: log.id,
      transactionHash: log.transaction?.hash ?? '',
      blockNumber: Number(log.transaction?.block?.number ?? 0),
      blockTimestamp: this.toDateTimeString(log.transaction?.timestamp ?? log.transaction?.block?.timestamp ?? null),
      logIndex: Number(log.logIndex ?? 0),
      address: log.address,
      topics: Array.isArray(log.topics) ? log.topics : [],
      data: log.data,
    }));
  }

  private toStringValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '0';
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value.toString() : '0';
    }

    if (typeof value === 'string') {
      return value;
    }

    return String(value);
  }

  private toDateTimeString(value: unknown): string {
    let date: Date | null = null;

    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'string') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        date = parsed;
      }
    }

    if (!date) {
      return '1970-01-01 00:00:00';
    }

    const iso = date.toISOString();
    return iso.replace('T', ' ').substring(0, 19);
  }
}
