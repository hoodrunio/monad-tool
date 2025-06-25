import { InternalTransactionTrace } from '../types'

/**
 * Interface for internal transaction tracing service
 * Following Interface Segregation Principle - focused on internal transactions only
 */
export interface IInternalTransactionService {
  /**
   * Traces internal transactions for a given transaction hash
   * @param transactionHash - The transaction hash to trace
   * @returns Promise with array of internal transaction traces
   */
  traceTransaction(transactionHash: string): Promise<InternalTransactionTrace[]>

  /**
   * Checks if transaction traces exist in cache
   * @param transactionHash - The transaction hash to check
   * @returns Promise with boolean indicating if traces exist in cache
   */
  hasTraces(transactionHash: string): Promise<boolean>

  /**
   * Gets cached traces without RPC calls
   * @param transactionHash - The transaction hash
   * @returns Promise with cached traces or null
   */
  getCachedTraces(transactionHash: string): Promise<InternalTransactionTrace[] | null>

  /**
   * Determines if a transaction should be traced based on criteria
   * @param transactionHash - The transaction hash
   * @param value - Transaction value in wei
   * @param gasUsed - Gas used by transaction
   * @returns Promise with boolean indicating if transaction should be traced
   */
  shouldTrace(transactionHash: string, value: bigint, gasUsed: bigint): Promise<boolean>
} 