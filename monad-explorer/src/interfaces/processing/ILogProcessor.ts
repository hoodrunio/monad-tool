import { Store } from '@subsquid/typeorm-store';
import { Log, Transaction, Token } from '../../model';
import { ParsedTokenTransfer } from './ILogTokenTransferParser';

export interface LogProcessingContext {
  store: Store;
  blockNumber: number;
  blockTimestamp: Date;
  transactionMap: Map<string, Transaction>;
}

export interface TokenTransferDetection {
  isTokenTransfer: boolean;
  transferType?: 'ERC20' | 'ERC721' | 'ERC1155';
  transfer?: ParsedTokenTransfer; // ✅ Now uses runtime-parsed transfer
  token?: Token;
}

export interface LogProcessingResult {
  processedLogs: Log[];
  tokenTransfers: ParsedTokenTransfer[]; // ✅ Now uses runtime-parsed transfers
  enrichedTokens: Token[];
  errors: Array<{ logId: string; error: string }>;
}

export interface LogProcessingOptions {
  enableTokenEnrichment?: boolean;
  enableAsyncProcessing?: boolean;
  batchSize?: number;
  timeout?: number;
}

export interface LogProcessingStats {
  totalLogs: number;
  processedLogs: number;
  detectedTransfers: number;
  enrichedTokens: number;
  errors: number;
  processingTime: number;
}

export interface ILogProcessor {
  /**
   * Process a batch of logs
   */
  processLogs(
    logs: Log[],
    context: LogProcessingContext,
    options?: LogProcessingOptions
  ): Promise<LogProcessingResult>;

  /**
   * Process a single log
   */
  processLog(
    log: Log,
    context: LogProcessingContext,
    options?: LogProcessingOptions
  ): Promise<TokenTransferDetection>;

  /**
   * Detect token transfers from logs
   */
  detectTokenTransfers(
    logs: Log[],
    context: LogProcessingContext
  ): Promise<TokenTransferDetection[]>;

  /**
   * Filter logs for token transfer events
   */
  filterTokenTransferLogs(logs: Log[]): Log[];

  /**
   * Validate log data
   */
  validateLog(log: Log): {
    isValid: boolean;
    errors: string[];
  };

  /**
   * Get processing statistics
   */
  getStats(): LogProcessingStats;

  /**
   * Reset statistics
   */
  resetStats(): void;
} 