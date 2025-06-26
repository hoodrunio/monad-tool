import { EvmBatchProcessor } from '@subsquid/evm-processor';
import { Store } from '@subsquid/typeorm-store';
import { TokenEnrichmentWorker } from './TokenEnrichmentWorker';
import { Token, TokenTransfer, Log, Transaction, Block } from '../model';
import * as erc20 from '../abi/ERC20';
import * as erc721 from '../abi/ERC721';
import * as erc1155 from '../abi/ERC1155';
import { logger } from '../utils/logger';

export interface EnhancedProcessorConfig {
  enableTokenEnrichment: boolean;
  enableAsyncProcessing: boolean;
  enrichmentWorker?: TokenEnrichmentWorker;
}

/**
 * Enhanced processor that detects token transfers and triggers background enrichment
 */
export class EnhancedProcessor {
  private readonly processor: EvmBatchProcessor;
  private readonly config: EnhancedProcessorConfig;
  private tokenEnrichmentWorker?: TokenEnrichmentWorker;
  private processedTokens = new Set<string>();

  constructor(processor: EvmBatchProcessor, config: EnhancedProcessorConfig) {
    this.processor = processor;
    this.config = config;
    this.tokenEnrichmentWorker = config.enrichmentWorker;
  }

  /**
   * Process logs from Subsquid processor context and detect token transfers
   */
  async processLogs(
    store: Store, 
    logs: Array<{ 
      address: string; 
      topics: string[]; 
      data: string; 
      transaction: { hash: string; block: { height: number; timestamp: number } };
      logIndex: number;
    }>
  ): Promise<void> {
    const tokenTransfers: TokenTransfer[] = [];
    const enrichmentJobs: Array<{
      tokenAddress: string;
      blockNumber: number;
      transactionHash: string;
      logIndex: number;
    }> = [];

    for (const logItem of logs) {
      try {
        // Try to decode as different token standards
        const transfer = await this.processTokenTransfer(store, logItem);
        if (transfer) {
          tokenTransfers.push(transfer);

          // Queue for enrichment if enabled
          if (this.config.enableTokenEnrichment && this.shouldEnrichToken(logItem.address)) {
            enrichmentJobs.push({
              tokenAddress: logItem.address,
              blockNumber: logItem.transaction.block.height,
              transactionHash: logItem.transaction.hash,
              logIndex: logItem.logIndex
            });
          }
        }
      } catch (error) {
        logger.debug('Failed to process log as token transfer', {
          address: logItem.address,
          transactionHash: logItem.transaction.hash,
          logIndex: logItem.logIndex,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Save token transfers to database
    if (tokenTransfers.length > 0) {
      await store.save(tokenTransfers);
      logger.info('Processed token transfers', { count: tokenTransfers.length });
    }

    // Queue enrichment jobs asynchronously
    if (this.config.enableAsyncProcessing && enrichmentJobs.length > 0) {
      this.queueEnrichmentJobs(enrichmentJobs);
    }
  }

  /**
   * Attempts to decode a log as a token transfer
   */
  private async processTokenTransfer(
    store: Store,
    logItem: { 
      address: string; 
      topics: string[]; 
      data: string; 
      transaction: { hash: string; block: { height: number; timestamp: number } };
      logIndex: number;
    }
  ): Promise<TokenTransfer | null> {
    const logRecord = { topics: logItem.topics, data: logItem.data };

    // Get or create transaction and log entities
    let transaction = await store.get(Transaction, logItem.transaction.hash);
    if (!transaction) {
      // Transaction doesn't exist yet, skip for now
      // In a real implementation, you'd create the transaction here
      return null;
    }

    let log = await store.get(Log, `${logItem.transaction.hash}-${logItem.logIndex}`);
    if (!log) {
      // Log doesn't exist yet, skip for now
      // In a real implementation, you'd create the log here
      return null;
    }

    // Try ERC20 Transfer event
    if (erc20.events.Transfer.is(logRecord)) {
      const transfer = erc20.events.Transfer.decode(logRecord);
      return new TokenTransfer({
        id: `${logItem.transaction.hash}-${logItem.logIndex}`,
        fromAddress: transfer.from,
        toAddress: transfer.to,
        value: transfer.value,
        tokenId: null,
        timestamp: new Date(logItem.transaction.block.timestamp * 1000),
        transaction,
        log
      });
    }

    // Try ERC721 Transfer event
    if (erc721.events.Transfer.is(logRecord)) {
      const transfer = erc721.events.Transfer.decode(logRecord);
      return new TokenTransfer({
        id: `${logItem.transaction.hash}-${logItem.logIndex}`,
        fromAddress: transfer.from,
        toAddress: transfer.to,
        value: 1n, // NFTs are always 1
        tokenId: transfer.tokenId,
        timestamp: new Date(logItem.transaction.block.timestamp * 1000),
        transaction,
        log
      });
    }

    // Try ERC1155 TransferSingle event
    if (erc1155.events.TransferSingle.is(logRecord)) {
      const transfer = erc1155.events.TransferSingle.decode(logRecord);
      return new TokenTransfer({
        id: `${logItem.transaction.hash}-${logItem.logIndex}`,
        fromAddress: transfer.from,
        toAddress: transfer.to,
        value: transfer.value,
        tokenId: transfer.id,
        timestamp: new Date(logItem.transaction.block.timestamp * 1000),
        transaction,
        log
      });
    }

    // Try ERC1155 TransferBatch event
    if (erc1155.events.TransferBatch.is(logRecord)) {
      const transfer = erc1155.events.TransferBatch.decode(logRecord);
      // For batch transfers, create multiple TokenTransfer entries
      // For simplicity, we'll just process the first one here
      const ids = transfer.ids;
      const values = transfer[4]; // values is the 5th element in the tuple
      if (ids.length > 0 && values.length > 0) {
        return new TokenTransfer({
          id: `${logItem.transaction.hash}-${logItem.logIndex}`,
          fromAddress: transfer.from,
          toAddress: transfer.to,
          value: values[0],
          tokenId: ids[0],
          timestamp: new Date(logItem.transaction.block.timestamp * 1000),
          transaction,
          log
        });
      }
    }

    return null;
  }

  /**
   * Determines if a token should be enriched
   */
  private shouldEnrichToken(tokenAddress: string): boolean {
    // Avoid duplicate enrichment jobs for the same token in a single batch
    if (this.processedTokens.has(tokenAddress)) {
      return false;
    }

    this.processedTokens.add(tokenAddress);
    return true;
  }

  /**
   * Queue enrichment jobs for background processing
   */
  private async queueEnrichmentJobs(
    jobs: Array<{
      tokenAddress: string;
      blockNumber: number;
      transactionHash: string;
      logIndex: number;
    }>
  ): Promise<void> {
    if (!this.tokenEnrichmentWorker) {
      logger.warn('Token enrichment worker not available, skipping enrichment jobs');
      return;
    }

    try {
      for (const job of jobs) {
        await this.tokenEnrichmentWorker.enqueueTokenEnrichment({
          tokenAddress: job.tokenAddress,
          blockNumber: job.blockNumber,
          transactionHash: job.transactionHash,
          logIndex: job.logIndex
        });
      }

      logger.info('Queued token enrichment jobs', { count: jobs.length });
    } catch (error) {
      logger.error('Failed to queue enrichment jobs', {
        error: error instanceof Error ? error.message : 'Unknown error',
        jobCount: jobs.length
      });
    }
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return {
      processedTokensCount: this.processedTokens.size,
      enrichmentEnabled: this.config.enableTokenEnrichment,
      asyncProcessingEnabled: this.config.enableAsyncProcessing,
      workerStatus: this.tokenEnrichmentWorker?.getStatus()
    };
  }

  /**
   * Clear processed tokens cache (call this at the start of each batch)
   */
  clearProcessedTokensCache(): void {
    this.processedTokens.clear();
  }
} 