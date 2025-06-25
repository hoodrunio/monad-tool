import { InternalTransaction } from '../../model'
import { InternalTransactionTrace } from '../types'

/**
 * Interface for internal transaction database operations
 * Following Repository Pattern and Interface Segregation Principle
 */
export interface IInternalTransactionRepository {
  /**
   * Finds internal transactions by transaction hash
   * @param transactionHash - Parent transaction hash
   * @returns Promise with array of internal transaction entities
   */
  findByTransactionHash(transactionHash: string): Promise<InternalTransaction[]>

  /**
   * Saves internal transactions from traces
   * @param transactionHash - Parent transaction hash
   * @param traces - Array of internal transaction traces
   * @returns Promise with array of saved internal transaction entities
   */
  saveFromTraces(transactionHash: string, traces: InternalTransactionTrace[]): Promise<InternalTransaction[]>

  /**
   * Checks if internal transactions exist for a transaction
   * @param transactionHash - Parent transaction hash
   * @returns Promise with boolean indicating if internal transactions exist
   */
  hasInternalTransactions(transactionHash: string): Promise<boolean>

  /**
   * Deletes internal transactions for a transaction
   * @param transactionHash - Parent transaction hash
   * @returns Promise with number of deleted records
   */
  deleteByTransactionHash(transactionHash: string): Promise<number>

  /**
   * Finds internal transactions by address (from or to)
   * @param address - Address to search for
   * @param limit - Maximum number of results (optional, defaults to 100)
   * @param offset - Offset for pagination (optional, defaults to 0)
   * @returns Promise with array of internal transaction entities
   */
  findByAddress(address: string, limit?: number, offset?: number): Promise<InternalTransaction[]>

  /**
   * Counts internal transactions by address
   * @param address - Address to count for
   * @returns Promise with count of internal transactions
   */
  countByAddress(address: string): Promise<number>

  /**
   * Gets internal transactions with value above threshold
   * @param minValue - Minimum value in wei
   * @param limit - Maximum number of results (optional, defaults to 100)
   * @returns Promise with array of internal transaction entities
   */
  findByMinValue(minValue: bigint, limit?: number): Promise<InternalTransaction[]>
} 