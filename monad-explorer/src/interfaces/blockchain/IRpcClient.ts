export interface RpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface RpcCallOptions {
  timeout?: number;
  retries?: number;
  blockTag?: string | number;
}

export interface ContractCallOptions extends RpcCallOptions {
  from?: string;
  gas?: string;
  gasPrice?: string;
}

export interface TraceOptions {
  tracer?: string;
  timeout?: string;
  disableMemory?: boolean;
  disableStack?: boolean;
  disableStorage?: boolean;
  enableMemory?: boolean;
  enableReturnData?: boolean;
}

export interface IRpcClient {
  /**
   * Make a raw JSON-RPC call
   */
  call<T = unknown>(
    method: string, 
    params?: unknown[], 
    options?: RpcCallOptions
  ): Promise<T>;

  /**
   * Get contract code at specific block
   */
  getCode(address: string, blockTag?: string | number): Promise<string>;

  /**
   * Call a contract method
   */
  callContract<T = unknown>(
    to: string,
    data: string,
    options?: ContractCallOptions
  ): Promise<T>;

  /**
   * Get current block number
   */
  getBlockNumber(): Promise<number>;

  /**
   * Get block by number or hash
   */
  getBlock(blockHashOrNumber: string | number, includeTransactions?: boolean): Promise<unknown>;

  /**
   * Get transaction by hash
   */
  getTransaction(hash: string): Promise<unknown>;

  /**
   * Get transaction receipt
   */
  getTransactionReceipt(hash: string): Promise<unknown>;

  /**
   * Extract error and revert reason from a failed transaction
   */
  getTransactionErrorInfo(hash: string): Promise<{ error: string | null; revertReason: string | null }>;

  /**
   * Extract revert reason from error message
   */
  extractRevertReason(errorMessage: string): string | null;

  /**
   * Trace transaction execution to get internal transactions
   */
  traceTransaction(hash: string, options?: TraceOptions): Promise<unknown>;

  /**
   * Check if client is healthy
   */
  isHealthy(): Promise<boolean>;

  /**
   * Get connection status
   */
  getConnectionStatus(): {
    connected: boolean;
    lastSuccessfulCall: Date | null;
    errorCount: number;
  };
} 