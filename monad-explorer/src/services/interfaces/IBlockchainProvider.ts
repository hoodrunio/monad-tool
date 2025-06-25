/**
 * Interface for blockchain RPC operations
 * Following Interface Segregation Principle - focused on blockchain interactions only
 */
export interface IBlockchainProvider {
  /**
   * Makes a contract call
   * @param address - Contract address
   * @param data - Call data
   * @param blockTag - Block tag (optional, defaults to 'latest')
   * @returns Promise with call result
   */
  call(address: string, data: string, blockTag?: string): Promise<string>

  /**
   * Makes multiple contract calls in a single request
   * @param calls - Array of call objects with address and data
   * @param blockTag - Block tag (optional, defaults to 'latest')
   * @returns Promise with array of call results
   */
  multicall(calls: Array<{address: string, data: string}>, blockTag?: string): Promise<string[]>

  /**
   * Traces a transaction to get internal transactions
   * @param transactionHash - Transaction hash to trace
   * @returns Promise with trace result
   */
  traceTransaction(transactionHash: string): Promise<any>

  /**
   * Gets transaction receipt
   * @param transactionHash - Transaction hash
   * @returns Promise with transaction receipt
   */
  getTransactionReceipt(transactionHash: string): Promise<any>

  /**
   * Gets current block number
   * @returns Promise with current block number
   */
  getBlockNumber(): Promise<number>

  /**
   * Checks if address is a contract
   * @param address - Address to check
   * @param blockTag - Block tag (optional, defaults to 'latest')
   * @returns Promise with boolean indicating if address is contract
   */
  isContract(address: string, blockTag?: string): Promise<boolean>
} 