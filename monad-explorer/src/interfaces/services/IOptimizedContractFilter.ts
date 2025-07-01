export interface ContractFilterResult {
  definiteContracts: string[]; // 100% certain contracts (from logs)
  candidateAddresses: string[]; // Need RPC verification
  skippedAddresses: string[]; // Already known or likely EOAs
  cacheHits: string[]; // Found in database/cache
}

export interface ContractFilterStats {
  totalAddresses: number;
  definiteContracts: number;
  candidatesFiltered: number;
  cacheHits: number;
  rpcCallsAvoided: number;
  processingTime: number;
}

export interface IOptimizedContractFilter {
  /**
   * Filter addresses using logs and database/cache checks
   * Minimizes RPC calls by pre-identifying known contracts
   */
  filterAddresses(
    addresses: string[],
    sourceMap: Map<string, any>,
    discoveryType: 'transaction' | 'log' | 'transfer'
  ): Promise<ContractFilterResult>;

  /**
   * Cache contract existence result for future use
   */
  cacheContractResult(address: string, isContract: boolean): Promise<void>;

  /**
   * Get filtering statistics
   */
  getStats(): ContractFilterStats;

  /**
   * Clear internal caches
   */
  clearCache(): void;
} 