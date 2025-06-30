import { Transaction, Log, Contract } from '../../model';

export interface ContractDiscoveryOptions {
  maxBatchSize?: number;
  cacheExistenceFor?: number;
  skipBytecodeOnCreation?: boolean;
}

export interface DiscoveredContract {
  address: string;
  discoveredIn: 'transaction' | 'log' | 'transfer' | 'api';
  blockNumber: number;
  transactionHash: string;
  creator?: string;
}

export interface IContractDiscoveryService {
  /**
   * Discover contracts from transaction batch
   */
  discoverFromTransactions(
    transactions: Transaction[],
    blockNumber: number
  ): Promise<DiscoveredContract[]>;

  /**
   * Discover contracts from log batch
   */
  discoverFromLogs(
    logs: Log[],
    blockNumber: number
  ): Promise<DiscoveredContract[]>;

  /**
   * Check if address is a contract (with caching)
   */
  isContract(address: string, blockNumber?: number): Promise<boolean>;

  /**
   * Get contracts that exist in database
   */
  getExistingContracts(addresses: string[]): Promise<Set<string>>;

  /**
   * Create basic contract entities without bytecode (lazy loading)
   */
  createBasicContracts(
    discoveredContracts: DiscoveredContract[]
  ): Promise<Contract[]>;

  /**
   * Clear existence cache
   */
  clearCache(): void;

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    memoryCacheSize: number;
    hitRate: number;
  };
} 