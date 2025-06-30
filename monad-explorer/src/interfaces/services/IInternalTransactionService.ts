export interface ParsedInternalTransaction {
  id: string; // Computed: txHash + traceIndex
  transactionHash: string;
  traceIndex: number;
  type: string; // CALL, DELEGATECALL, STATICCALL, CREATE, SELFDESTRUCT
  fromAddress: string;
  toAddress: string | null;
  value: bigint;
  gas: bigint;
  gasUsed: bigint;
  input: string | null;
  output: string | null;
  error: string | null;
  depth: number; // Call stack depth
  blockNumber: number;
  timestamp: Date;
  
  // Parent trace reference
  parentTraceIndex?: number;
  
  // Metadata
  success: boolean;
  revertReason?: string;
}

export interface TraceCallFrame {
  type: string;
  from: string;
  to?: string;
  value?: string;
  gas: string;
  gasUsed: string;
  input: string;
  output?: string;
  error?: string;
  calls?: TraceCallFrame[];
}

export interface TraceResult {
  type: string;
  from: string;
  to?: string;
  value?: string;
  gas: string;
  gasUsed: string;
  input: string;
  output?: string;
  error?: string;
  calls?: TraceCallFrame[];
}

export interface InternalTransactionParsingOptions {
  includeFailedCalls?: boolean;
  maxDepth?: number;
  filterByAddress?: string;
}

export interface InternalTransactionParsingResult {
  internalTransactions: ParsedInternalTransaction[];
  totalTraces: number;
  successfulTraces: number;
  failedTraces: number;
  maxDepth: number;
  processingTime: number;
}

export interface IInternalTransactionService {
  /**
   * Get internal transactions for a specific transaction hash
   */
  getInternalTransactions(
    txHash: string,
    options?: InternalTransactionParsingOptions
  ): Promise<ParsedInternalTransaction[]>;

  /**
   * Check if a transaction has internal transactions without full parsing
   */
  hasInternalTransactions(txHash: string): Promise<boolean>;

  /**
   * Get internal transactions involving a specific address
   */
  getInternalTransactionsForAddress(
    address: string,
    limit?: number,
    offset?: number,
    options?: InternalTransactionParsingOptions
  ): Promise<{
    internalTransactions: ParsedInternalTransaction[];
    total: number;
  }>;

  /**
   * Parse trace result into internal transactions
   */
  parseTraceResult(
    trace: TraceResult,
    txHash: string,
    blockNumber: number,
    timestamp: Date,
    options?: InternalTransactionParsingOptions
  ): Promise<InternalTransactionParsingResult>;
} 