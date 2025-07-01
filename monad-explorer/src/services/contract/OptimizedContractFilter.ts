import { ICacheService } from '../../interfaces/cache/ICacheService';
import { 
  IOptimizedContractFilter, 
  ContractFilterResult, 
  ContractFilterStats 
} from '../../interfaces/services/IOptimizedContractFilter';
import { logger } from '../../utils/logger';
import { DataSource } from 'typeorm';

/**
 * Optimized Contract Filter - Minimizes RPC calls through intelligent pre-filtering
 * Uses logs, database, and cache to identify contracts without expensive getCode calls
 */
export class OptimizedContractFilter implements IOptimizedContractFilter {
  private readonly cachePrefix = 'contract_exists:';
  private readonly cacheTtl = 86400; // 24 hours (contracts don't disappear)
  
  // Statistics tracking
  private stats: ContractFilterStats = {
    totalAddresses: 0,
    definiteContracts: 0,
    candidatesFiltered: 0,
    cacheHits: 0,
    rpcCallsAvoided: 0,
    processingTime: 0,
  };

  // Memory cache for recent checks
  private memoryCache = new Map<string, boolean>();
  private readonly maxMemoryCacheSize = 10000;

  constructor(
    private readonly cacheService: ICacheService,
    private readonly dataSource?: DataSource
  ) {}

  /**
   * Filter addresses using logs and database/cache checks
   */
  public async filterAddresses(
    addresses: string[],
    sourceMap: Map<string, any>,
    discoveryType: 'transaction' | 'log' | 'transfer'
  ): Promise<ContractFilterResult> {
    const startTime = Date.now();
    
    if (addresses.length === 0) {
      return this.createEmptyResult();
    }

    this.stats.totalAddresses += addresses.length;

    logger.debug('Starting optimized contract filtering', {
      addressCount: addresses.length,
      discoveryType,
    });

    const result: ContractFilterResult = {
      definiteContracts: [],
      candidateAddresses: [],
      skippedAddresses: [],
      cacheHits: [],
    };

    // Phase 1: Log-based definite contracts (100% certain)
    if (discoveryType === 'log') {
      // If we're discovering from logs, all addresses are definitely contracts
      result.definiteContracts = [...addresses];
      this.stats.definiteContracts += addresses.length;
      this.stats.rpcCallsAvoided += addresses.length;
      
      logger.debug('Log-based discovery: all addresses are definite contracts', {
        definiteContracts: addresses.length,
      });
      
      this.updateProcessingTime(startTime);
      return result;
    }

    // Phase 2: Database check (known contracts)
    const databaseKnown = await this.checkDatabase(addresses);
    result.cacheHits.push(...databaseKnown);
    this.stats.cacheHits += databaseKnown.length;
    this.stats.rpcCallsAvoided += databaseKnown.length;

    // Phase 3: Redis cache check (recently verified)
    const unknownAfterDb = addresses.filter(addr => 
      !databaseKnown.includes(addr.toLowerCase())
    );
    
    const cacheKnown = await this.checkRedisCache(unknownAfterDb);
    result.cacheHits.push(...cacheKnown);
    this.stats.cacheHits += cacheKnown.length;
    this.stats.rpcCallsAvoided += cacheKnown.length;

    // Phase 4: Memory cache check (very recent)
    const unknownAfterCache = unknownAfterDb.filter(addr =>
      !cacheKnown.includes(addr.toLowerCase())
    );

    const memoryCacheResults = this.checkMemoryCache(unknownAfterCache);
    result.cacheHits.push(...memoryCacheResults.known);
    this.stats.cacheHits += memoryCacheResults.known.length;
    this.stats.rpcCallsAvoided += memoryCacheResults.known.length;

    // Remaining candidates need RPC verification
    result.candidateAddresses = memoryCacheResults.unknown;
    this.stats.candidatesFiltered += result.candidateAddresses.length;

    const totalFiltered = result.definiteContracts.length + 
                         result.cacheHits.length + 
                         result.skippedAddresses.length;

    logger.debug('Optimized filtering completed', {
      total: addresses.length,
      definiteContracts: result.definiteContracts.length,
      cacheHits: result.cacheHits.length,
      candidates: result.candidateAddresses.length,
      skipped: result.skippedAddresses.length,
      rpcCallsAvoided: totalFiltered,
      reductionPercentage: ((totalFiltered / addresses.length) * 100).toFixed(1),
    });

    this.updateProcessingTime(startTime);
    return result;
  }

  /**
   * Check database for known contracts
   */
  private async checkDatabase(addresses: string[]): Promise<string[]> {
    if (!this.dataSource || !this.dataSource.isInitialized || addresses.length === 0) {
      return [];
    }

    try {
      const normalizedAddresses = addresses.map(addr => addr.toLowerCase());
      
      // Check both Contract and Account tables
      const [contracts, accounts] = await Promise.all([
        this.dataSource.query(`
          SELECT address FROM contract 
          WHERE address = ANY($1)
        `, [normalizedAddresses]),
        
        this.dataSource.query(`
          SELECT address FROM account 
          WHERE address = ANY($1) AND is_contract = true
        `, [normalizedAddresses])
      ]);

      const knownContracts = new Set([
        ...contracts.map((c: any) => c.address),
        ...accounts.map((a: any) => a.address),
      ]);

      return Array.from(knownContracts);
    } catch (error) {
      logger.warn('Database check failed, skipping', {
        error: error instanceof Error ? error.message : 'Unknown error',
        addressCount: addresses.length,
      });
      return [];
    }
  }

  /**
   * Check Redis cache for recently verified contracts
   */
  private async checkRedisCache(addresses: string[]): Promise<string[]> {
    if (addresses.length === 0) {
      return [];
    }

    try {
      const cacheKeys = addresses.map(addr => `${this.cachePrefix}${addr.toLowerCase()}`);
      const cacheResults = await Promise.all(
        cacheKeys.map(key => this.cacheService.get<boolean>(key))
      );

      const knownContracts: string[] = [];
      
      for (let i = 0; i < addresses.length; i++) {
        const cacheResult = cacheResults[i];
        if (cacheResult === true) {
          knownContracts.push(addresses[i].toLowerCase());
          // Update memory cache
          this.memoryCache.set(addresses[i].toLowerCase(), true);
        }
      }

      return knownContracts;
    } catch (error) {
      logger.debug('Redis cache check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        addressCount: addresses.length,
      });
      return [];
    }
  }

  /**
   * Check memory cache for very recent verifications
   */
  private checkMemoryCache(addresses: string[]): { known: string[]; unknown: string[] } {
    const known: string[] = [];
    const unknown: string[] = [];

    for (const address of addresses) {
      const normalizedAddress = address.toLowerCase();
      
      if (this.memoryCache.has(normalizedAddress)) {
        const isContract = this.memoryCache.get(normalizedAddress);
        if (isContract) {
          known.push(normalizedAddress);
        }
        // If isContract is false, we don't add to known, but we also don't need to RPC check again
      } else {
        unknown.push(normalizedAddress);
      }
    }

    return { known, unknown };
  }

  /**
   * Cache contract existence result
   */
  public async cacheContractResult(address: string, isContract: boolean): Promise<void> {
    const normalizedAddress = address.toLowerCase();
    
    try {
      // Update memory cache
      this.updateMemoryCache(normalizedAddress, isContract);
      
      // Update Redis cache
      const cacheKey = `${this.cachePrefix}${normalizedAddress}`;
      await this.cacheService.set(cacheKey, isContract, this.cacheTtl);
    } catch (error) {
      logger.debug('Failed to cache contract result', {
        address: normalizedAddress,
        isContract,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Update memory cache with size limit
   */
  private updateMemoryCache(address: string, isContract: boolean): void {
    // Simple LRU: if cache is full, remove oldest entry
    if (this.memoryCache.size >= this.maxMemoryCacheSize) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) {
        this.memoryCache.delete(firstKey);
      }
    }
    
    this.memoryCache.set(address, isContract);
  }

  /**
   * Get filtering statistics
   */
  public getStats(): ContractFilterStats {
    return { ...this.stats };
  }

  /**
   * Clear all caches
   */
  public clearCache(): void {
    this.memoryCache.clear();
    logger.debug('Optimized contract filter caches cleared');
  }

  /**
   * Update processing time statistics
   */
  private updateProcessingTime(startTime: number): void {
    const processingTime = Date.now() - startTime;
    this.stats.processingTime += processingTime;
  }

  /**
   * Create empty result structure
   */
  private createEmptyResult(): ContractFilterResult {
    return {
      definiteContracts: [],
      candidateAddresses: [],
      skippedAddresses: [],
      cacheHits: [],
    };
  }

  /**
   * Get cache statistics for monitoring
   */
  public getCacheStats(): {
    memoryCacheSize: number;
    totalCacheChecks: number;
    cacheHitRate: number;
  } {
    const totalChecks = this.stats.totalAddresses;
    const hitRate = totalChecks > 0 ? (this.stats.cacheHits / totalChecks) * 100 : 0;

    return {
      memoryCacheSize: this.memoryCache.size,
      totalCacheChecks: totalChecks,
      cacheHitRate: hitRate,
    };
  }
} 