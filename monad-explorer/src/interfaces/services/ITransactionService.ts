import { ParsedTokenTransfer } from '../processing/ILogTokenTransferParser';

export interface EnrichedTransaction {
  // Base transaction data
  id: string;
  hash: string;
  blockNumber: number;
  transactionIndex: number;
  fromAddress: string;
  toAddress: string | null;
  value: bigint;
  gas: bigint;
  gasPrice: bigint;
  gasUsed: bigint;
  status: number;
  timestamp: Date;
  input: string;
  
  // Enriched data (computed at runtime)
  tokenTransfers: ParsedTokenTransfer[];
  decodedLogs: Array<{
    logIndex: number;
    address: string;
    eventName?: string;
    eventSignature?: string;
    decodedData?: any;
  }>;
  
  // Metadata
  methodName?: string;
  methodID?: string;
  isContractInteraction: boolean;
  isContractCreation: boolean;
  effectiveGasPrice: bigint;
  transactionFee: bigint;
}

export interface TransactionQueryOptions {
  includeTokenTransfers?: boolean;
  includeDecodedLogs?: boolean;
  includeTokenMetadata?: boolean;
}

export interface ITransactionService {
  /**
   * Get enriched transaction data with runtime-parsed token transfers
   */
  getEnrichedTransaction(
    hash: string, 
    options?: TransactionQueryOptions
  ): Promise<EnrichedTransaction | null>;

  /**
   * Get enriched transactions for a block
   */
  getEnrichedTransactionsForBlock(
    blockNumber: number,
    options?: TransactionQueryOptions
  ): Promise<EnrichedTransaction[]>;

  /**
   * Get enriched transactions for an address (from/to)
   */
  getEnrichedTransactionsForAddress(
    address: string,
    limit?: number,
    offset?: number,
    options?: TransactionQueryOptions
  ): Promise<{
    transactions: EnrichedTransaction[];
    total: number;
  }>;

  /**
   * Get token transfers for a transaction (runtime-parsed from logs)
   */
  getTokenTransfersForTransaction(
    hash: string,
    options?: { includeMetadata?: boolean }
  ): Promise<ParsedTokenTransfer[]>;

  /**
   * Get token transfers for an address
   */
  getTokenTransfersForAddress(
    address: string,
    tokenAddress?: string,
    limit?: number,
    offset?: number,
    options?: { includeMetadata?: boolean }
  ): Promise<{
    transfers: ParsedTokenTransfer[];
    total: number;
  }>;
} 