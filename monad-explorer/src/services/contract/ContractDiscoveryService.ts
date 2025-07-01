import { IRpcClient } from '../../interfaces/blockchain/IRpcClient';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { 
  IContractDiscoveryService, 
  ContractDiscoveryOptions, 
  DiscoveredContract 
} from '../../interfaces/services/IContractDiscoveryService';
import { IOptimizedContractFilter } from '../../interfaces/services/IOptimizedContractFilter';
import { Contract, Transaction, Log } from '../../model';
import { logger } from '../../utils/logger';
import { DataSource } from 'typeorm';

/**
 * Contract Discovery Service - On-demand contract detection
 * Discovers unknown contracts from transactions and logs efficiently
 * Avoids unnecessary RPC calls and storage using smart caching
 */
export class ContractDiscoveryService implements IContractDiscoveryService {
  private readonly existenceCache = new Map<string, boolean>();
  private readonly cachePrefix = 'contract_exists:';
  private readonly defaultOptions: Required<ContractDiscoveryOptions> = {
    maxBatchSize: 50,
    cacheExistenceFor: 86400, // 24 hours (contracts don't disappear)
    skipBytecodeOnCreation: true, // Lazy bytecode fetching
  };

  constructor(
    private readonly rpcClient: IRpcClient,
    private readonly cacheService: ICacheService,
    private readonly optimizedFilter: IOptimizedContractFilter,
    private readonly dataSource?: DataSource,
    private readonly options: ContractDiscoveryOptions = {}
  ) {
    this.defaultOptions = { ...this.defaultOptions, ...options };
  }

  /**
   * Discover contracts from transaction batch
   */
  public async discoverFromTransactions(
    transactions: Transaction[],
    blockNumber: number
  ): Promise<DiscoveredContract[]> {
    const addresses = new Set<string>();
    const addressToTx = new Map<string, Transaction>();

    // Collect unique contract addresses from transactions
    for (const tx of transactions) {
      if (tx.toAddress) {
        addresses.add(tx.toAddress.toLowerCase());
        addressToTx.set(tx.toAddress.toLowerCase(), tx);
      }
    }

    return this.discoverContractsFromAddresses(
      Array.from(addresses),
      blockNumber,
      'transaction',
      addressToTx
    );
  }

  /**
   * Discover contracts from log batch
   */
  public async discoverFromLogs(
    logs: Log[],
    blockNumber: number
  ): Promise<DiscoveredContract[]> {
    const addresses = new Set<string>();
    const addressToLog = new Map<string, Log>();

    // Collect unique contract addresses from logs
    for (const log of logs) {
      addresses.add(log.address.toLowerCase());
      addressToLog.set(log.address.toLowerCase(), log);
    }

    return this.discoverContractsFromAddresses(
      Array.from(addresses),
      blockNumber,
      'log',
      addressToLog
    );
  }

  /**
   * Check if address is a contract (with caching)
   */
  public async isContract(address: string, blockNumber?: number): Promise<boolean> {
    const normalizedAddress = address.toLowerCase();
    const cacheKey = `${this.cachePrefix}${normalizedAddress}`;

    // Check memory cache first
    if (this.existenceCache.has(normalizedAddress)) {
      return this.existenceCache.get(normalizedAddress)!;
    }

    // Check Redis cache
    try {
      const cached = await this.cacheService.get<boolean>(cacheKey);
      if (cached !== null) {
        this.existenceCache.set(normalizedAddress, cached);
        return cached;
      }
    } catch (error) {
      logger.debug('Cache miss for contract existence', { address: normalizedAddress });
    }

    // Make RPC call
    try {
      const code = await this.rpcClient.getCode(normalizedAddress, blockNumber || 'latest');
      const isContract = Boolean(code && code !== '0x' && code.length > 2);

      // Cache result
      this.existenceCache.set(normalizedAddress, isContract);
      await this.cacheService.set(cacheKey, isContract, this.defaultOptions.cacheExistenceFor);

      return isContract;
    } catch (error) {
      logger.debug('Failed to check contract existence', {
        address: normalizedAddress,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Get contracts that exist in database
   */
  public async getExistingContracts(addresses: string[]): Promise<Set<string>> {
    if (!this.dataSource || !this.dataSource.isInitialized || addresses.length === 0) {
      return new Set();
    }

    try {
      const normalizedAddresses = addresses.map(addr => addr.toLowerCase());
      const existingContracts = await this.dataSource.query(`
        SELECT address FROM contract 
        WHERE address = ANY($1)
      `, [normalizedAddresses]);

      return new Set(existingContracts.map((c: any) => c.address));
    } catch (error) {
      logger.warn('Failed to check existing contracts in database', {
        addresses: addresses.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return new Set();
    }
  }

  /**
   * Create basic contract entities without bytecode (lazy loading)
   */
  public async createBasicContracts(
    discoveredContracts: DiscoveredContract[]
  ): Promise<Contract[]> {
    const contracts: Contract[] = [];

    for (const discovered of discoveredContracts) {
      const contract = new Contract({
        id: discovered.address,
        address: discovered.address,
        creator: discovered.creator || 'unknown', // Will be enriched later if possible
        createdAt: new Date(),
        bytecode: null, // Lazy loading - will be fetched on-demand
        sourceCode: null,
        isVerified: false,
        name: null,
        compilerVersion: null,
        // Note: creationTransaction will be null for discovered contracts
        creationTransaction: null as any, // Type assertion needed
      });

      contracts.push(contract);
    }

    logger.debug('Created basic contract entities', {
      count: contracts.length,
      addresses: contracts.map(c => c.address).slice(0, 5), // Log first 5 addresses
    });

    return contracts;
  }

  /**
   * Batch check and discover contracts from addresses
   */
  private async discoverContractsFromAddresses(
    addresses: string[],
    blockNumber: number,
    discoveryType: 'transaction' | 'log' | 'transfer',
    sourceMap: Map<string, any>
  ): Promise<DiscoveredContract[]> {
    if (addresses.length === 0) {
      return [];
    }

    // Pass DataSource to optimized filter if available
    if (this.dataSource) {
      (this.optimizedFilter as any).dataSource = this.dataSource;
    }

    // Use optimized filtering
    const filterResult = await this.optimizedFilter.filterAddresses(addresses, sourceMap, discoveryType);
    
    const discovered: DiscoveredContract[] = [];

    // Add definite contracts (no RPC needed)
    for (const address of filterResult.definiteContracts) {
      const source = sourceMap.get(address.toLowerCase());
      discovered.push({
        address: address.toLowerCase(),
        discoveredIn: discoveryType,
        blockNumber,
        transactionHash: source?.hash || source?.transaction?.hash || 'unknown',
        creator: this.extractCreator(source),
      });
    }

    // Add cache hits (already known contracts)
    for (const address of filterResult.cacheHits) {
      const source = sourceMap.get(address.toLowerCase());
      if (source) { // Ensure source exists before creating a discovered contract
        discovered.push({
          address: address.toLowerCase(),
          discoveredIn: discoveryType,
          blockNumber,
          transactionHash: source.hash || source.transaction?.hash || 'unknown',
          creator: this.extractCreator(source),
        });
      }
    }

    const filterStats = this.optimizedFilter.getStats();
    logger.debug('Optimized contract discovery completed', {
      total: addresses.length,
      definiteContracts: filterResult.definiteContracts.length,
      cacheHits: filterResult.cacheHits.length,
      rpcCandidates: filterResult.candidateAddresses.length,
      skipped: filterResult.skippedAddresses.length,
      discovered: discovered.length,
      rpcCallsAvoided: filterStats.rpcCallsAvoided + filterResult.candidateAddresses.length, // Also count candidates as avoided
      discoveryType,
      blockNumber,
    });

    return discovered;
  }

  /**
   * Extract creator from transaction or log (if possible)
   */
  private extractCreator(source: any): string | undefined {
    if (source?.fromAddress) {
      return source.fromAddress.toLowerCase();
    }
    if (source?.transaction?.fromAddress) {
      return source.transaction.fromAddress.toLowerCase();
    }
    return undefined;
  }

  /**
   * Clear existence cache
   */
  public clearCache(): void {
    this.existenceCache.clear();
    logger.debug('Contract existence cache cleared');
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): {
    memoryCacheSize: number;
    hitRate: number;
  } {
    return {
      memoryCacheSize: this.existenceCache.size,
      hitRate: 0, // Could be calculated if we track hits/misses
    };
  }
} 