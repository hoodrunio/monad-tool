import { IRpcClient } from '../../interfaces/blockchain/IRpcClient';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { TokenType } from '../../model';
import * as erc20 from '../../abi/ERC20';
import * as erc721 from '../../abi/ERC721';
import * as erc1155 from '../../abi/ERC1155';
import { Multicall, MulticallResult } from '../../abi/multicall';
import { ChainContext, Block } from '../../abi/abi.support';
import { logger } from '../../utils/logger';

export interface TokenBalance {
  tokenAddress: string;
  balance: bigint;
  tokenType: TokenType;
  metadata?: {
    name?: string;
    symbol?: string;
    decimals?: number;
  };
}

export interface OnChainBalanceResult {
  address: string;
  nativeBalance?: bigint | null;
  tokenBalances: TokenBalance[];
  fromCache: boolean;
  queryTime: number;
}

export interface BalanceQueryOptions {
  includeNativeBalance?: boolean;
  includeMetadata?: boolean;
  useCache?: boolean;
  cacheTtl?: number;
  blockNumber?: number;
}

/**
 * Service for querying token balances directly from the blockchain
 * Uses multicall for efficiency and includes caching
 */
export class OnChainBalanceService {
  private static readonly MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
  private readonly defaultCacheTtl = 300; // 5 minutes cache
  private readonly balanceCachePrefix = 'balance:';

  constructor(
    private readonly rpcClient: IRpcClient,
    private readonly cacheService?: ICacheService
  ) {}

  /**
   * Get balance for a specific token
   */
  public async getTokenBalance(
    address: string,
    tokenAddress: string,
    tokenType: TokenType,
    options: BalanceQueryOptions = {}
  ): Promise<TokenBalance | null> {
    const startTime = Date.now();
    const cacheKey = this.buildCacheKey(address, tokenAddress, options.blockNumber);

    // Check cache first
    if (options.useCache !== false && this.cacheService) {
      try {
        const cached = await this.cacheService.get<TokenBalance>(cacheKey);
        if (cached) {
          logger.debug('Balance served from cache', { address, tokenAddress, cacheKey });
          return cached;
        }
      } catch (error) {
        logger.debug('Cache read failed', { error: error instanceof Error ? error.message : 'Unknown' });
      }
    }

    try {
      const balance = await this.querySingleTokenBalance(address, tokenAddress, tokenType, options);
      
      if (balance && options.useCache !== false && this.cacheService) {
        const ttl = options.cacheTtl || this.defaultCacheTtl;
        await this.cacheService.set(cacheKey, balance, ttl);
      }

      return balance;
    } catch (error) {
      logger.error('Failed to query token balance', {
        address,
        tokenAddress,
        tokenType,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Get balances for multiple tokens using multicall
   */
  public async getMultipleTokenBalances(
    address: string,
    tokens: Array<{ address: string; type: TokenType }>,
    options: BalanceQueryOptions = {}
  ): Promise<OnChainBalanceResult> {
    const startTime = Date.now();
    
    try {
      // Native balance query if requested
      const nativeBalancePromise = options.includeNativeBalance
        ? this.getNativeBalance(address, options.blockNumber).catch(error => {
            logger.error('Native balance query failed, will return null', {
              address,
              blockNumber: options.blockNumber,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
            return null;
          })
        : Promise.resolve(undefined);

      // Group tokens by type for efficient multicall
      const erc20Tokens = tokens.filter(t => t.type === TokenType.ERC20);
      const erc721Tokens = tokens.filter(t => t.type === TokenType.ERC721);
      const erc1155Tokens = tokens.filter(t => t.type === TokenType.ERC1155);

      const [nativeBalance, erc20Balances, erc721Balances, erc1155Balances] = await Promise.all([
        nativeBalancePromise,
        erc20Tokens.length > 0 ? this.queryERC20BalancesWithMulticall(address, erc20Tokens.map(t => t.address), options) : [],
        erc721Tokens.length > 0 ? this.queryERC721BalancesWithMulticall(address, erc721Tokens.map(t => t.address), options) : [],
        erc1155Tokens.length > 0 ? this.queryERC1155BalancesWithMulticall(address, erc1155Tokens.map(t => t.address), options) : []
      ]);

      const allBalances = [
        ...erc20Balances,
        ...erc721Balances,
        ...erc1155Balances
      ].filter(balance => balance !== null) as TokenBalance[];

      const queryTime = Date.now() - startTime;

      logger.info('Multiple token balances queried', {
        address,
        tokenCount: tokens.length,
        foundBalances: allBalances.length,
        queryTime: `${queryTime}ms`,
        approach: 'multicall'
      });

      return {
        address,
        nativeBalance,
        tokenBalances: allBalances,
        fromCache: false,
        queryTime
      };
    } catch (error) {
      logger.error('Failed to query multiple token balances', {
        address,
        tokenCount: tokens.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return {
        address,
        tokenBalances: [],
        fromCache: false,
        queryTime: Date.now() - startTime
      };
    }
  }

  /**
   * Get native token balance (ETH/MONAD)
   */
  private async getNativeBalance(address: string, blockNumber?: number): Promise<bigint> {
    try {
      const blockTag = blockNumber && blockNumber > 1000 ? `0x${blockNumber.toString(16)}` : 'latest';
      logger.debug('Querying native balance', { address, blockTag });
      
      const balance = await this.rpcClient.call<string>('eth_getBalance', [address, blockTag]);
      logger.debug('Native balance result', { address, balance, blockTag });
      
      return BigInt(balance);
    } catch (error) {
      logger.error('Failed to get native balance', {
        address,
        blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Query single token balance
   */
  private async querySingleTokenBalance(
    address: string,
    tokenAddress: string,
    tokenType: TokenType,
    options: BalanceQueryOptions
  ): Promise<TokenBalance | null> {
    const context = this.createChainContext();
    const block = this.createBlock(options.blockNumber);

    try {
      let balance: bigint;
      let metadata: { name?: string; symbol?: string; decimals?: number } | undefined;

      switch (tokenType) {
        case TokenType.ERC20: {
          const contract = new erc20.Contract(context, block, tokenAddress);
          balance = await contract.balanceOf(address);
          
          if (options.includeMetadata) {
            const [name, symbol, decimals] = await Promise.allSettled([
              contract.name(),
              contract.symbol(),
              contract.decimals()
            ]);
            
            metadata = {
              name: name.status === 'fulfilled' ? name.value : undefined,
              symbol: symbol.status === 'fulfilled' ? symbol.value : undefined,
              decimals: decimals.status === 'fulfilled' ? Number(decimals.value) : undefined
            };
          }
          break;
        }
        
        case TokenType.ERC721: {
          const contract = new erc721.Contract(context, block, tokenAddress);
          balance = await contract.balanceOf(address);
          
          if (options.includeMetadata) {
            const [name, symbol] = await Promise.allSettled([
              contract.name(),
              contract.symbol()
            ]);
            
            metadata = {
              name: name.status === 'fulfilled' ? name.value : undefined,
              symbol: symbol.status === 'fulfilled' ? symbol.value : undefined
            };
          }
          break;
        }
        
        case TokenType.ERC1155:
          // ERC1155 balanceOf requires tokenId, skip for now
          logger.debug('ERC1155 balance query skipped (requires tokenId)', { tokenAddress });
          return null;
          
        default:
          logger.warn('Unsupported token type for balance query', { tokenAddress, tokenType });
          return null;
      }

      // Only return if balance > 0
      if (balance > 0n) {
        return {
          tokenAddress,
          balance,
          tokenType,
          metadata
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Query ERC20 balances using multicall
   */
  private async queryERC20BalancesWithMulticall(
    address: string,
    tokenAddresses: string[],
    options: BalanceQueryOptions
  ): Promise<(TokenBalance | null)[]> {
    const context = this.createChainContext();
    const block = this.createBlock(options.blockNumber);
    const multicall = new Multicall(context, block, OnChainBalanceService.MULTICALL3_ADDRESS);

    // Prepare balance calls
    const balanceCalls: [any, string, any[]][] = tokenAddresses.map(tokenAddr => [
      erc20.functions.balanceOf,
      tokenAddr,
      [address]
    ]);

    // Prepare metadata calls if requested
    const metadataCalls: [any, string, any[]][] = options.includeMetadata 
      ? tokenAddresses.flatMap(tokenAddr => [
          [erc20.functions.name, tokenAddr, []],
          [erc20.functions.symbol, tokenAddr, []],
          [erc20.functions.decimals, tokenAddr, []]
        ])
      : [];

    try {
      const [balanceResults, metadataResults] = await Promise.all([
        multicall.tryAggregate(balanceCalls),
        metadataCalls.length > 0 ? multicall.tryAggregate(metadataCalls) : []
      ]);

      return tokenAddresses.map((tokenAddress, index) => {
        const balanceResult = balanceResults[index];
        
        if (!balanceResult.success || !balanceResult.value || balanceResult.value === 0n) {
          return null;
        }

        let metadata: { name?: string; symbol?: string; decimals?: number } | undefined;
        
        if (options.includeMetadata && metadataResults.length > 0) {
          const metadataIndex = index * 3;
          const nameResult = metadataResults[metadataIndex];
          const symbolResult = metadataResults[metadataIndex + 1];
          const decimalsResult = metadataResults[metadataIndex + 2];
          
          metadata = {
            name: nameResult?.success ? nameResult.value : undefined,
            symbol: symbolResult?.success ? symbolResult.value : undefined,
            decimals: decimalsResult?.success ? Number(decimalsResult.value) : undefined
          };
        }

        return {
          tokenAddress,
          balance: balanceResult.value,
          tokenType: TokenType.ERC20,
          metadata
        };
      });
    } catch (error) {
      logger.warn('ERC20 multicall balance query failed, falling back to individual calls', {
        address,
        tokenCount: tokenAddresses.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Fallback: Query each token individually
      return await this.queryBalancesIndividually(address, tokenAddresses, TokenType.ERC20, erc20, options);
    }
  }

  /**
   * Query ERC721 balances using multicall
   */
  private async queryERC721BalancesWithMulticall(
    address: string,
    tokenAddresses: string[],
    options: BalanceQueryOptions
  ): Promise<(TokenBalance | null)[]> {
    const context = this.createChainContext();
    const block = this.createBlock(options.blockNumber);
    const multicall = new Multicall(context, block, OnChainBalanceService.MULTICALL3_ADDRESS);

    const balanceCalls: [any, string, any[]][] = tokenAddresses.map(tokenAddr => [
      erc721.functions.balanceOf,
      tokenAddr,
      [address]
    ]);

    const metadataCalls: [any, string, any[]][] = options.includeMetadata 
      ? tokenAddresses.flatMap(tokenAddr => [
          [erc721.functions.name, tokenAddr, []],
          [erc721.functions.symbol, tokenAddr, []]
        ])
      : [];

    try {
      const [balanceResults, metadataResults] = await Promise.all([
        multicall.tryAggregate(balanceCalls),
        metadataCalls.length > 0 ? multicall.tryAggregate(metadataCalls) : []
      ]);

      return tokenAddresses.map((tokenAddress, index) => {
        const balanceResult = balanceResults[index];
        
        if (!balanceResult.success || !balanceResult.value || balanceResult.value === 0n) {
          return null;
        }

        let metadata: { name?: string; symbol?: string; decimals?: number } | undefined;
        
        if (options.includeMetadata && metadataResults.length > 0) {
          const metadataIndex = index * 2;
          const nameResult = metadataResults[metadataIndex];
          const symbolResult = metadataResults[metadataIndex + 1];
          
          metadata = {
            name: nameResult?.success ? nameResult.value : undefined,
            symbol: symbolResult?.success ? symbolResult.value : undefined
          };
        }

        return {
          tokenAddress,
          balance: balanceResult.value,
          tokenType: TokenType.ERC721,
          metadata
        };
      });
    } catch (error) {
      logger.warn('ERC721 multicall balance query failed, falling back to individual calls', {
        address,
        tokenCount: tokenAddresses.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Fallback: Query each token individually
      return await this.queryBalancesIndividually(address, tokenAddresses, TokenType.ERC721, erc721, options);
    }
  }

  /**
   * Query ERC1155 balances (placeholder - requires tokenIds)
   */
  private async queryERC1155BalancesWithMulticall(
    address: string,
    tokenAddresses: string[],
    options: BalanceQueryOptions
  ): Promise<(TokenBalance | null)[]> {
    // ERC1155 requires specific tokenIds, which we don't have context for
    // This would need additional logic to determine which tokenIds to query
    logger.debug('ERC1155 multicall skipped (requires tokenIds)', { 
      tokenCount: tokenAddresses.length 
    });
    return tokenAddresses.map(() => null);
  }

  /**
   * Build cache key for balance
   */
  private buildCacheKey(address: string, tokenAddress: string, blockNumber?: number): string {
    const block = blockNumber && blockNumber > 1000 ? blockNumber : 'latest';
    return `${this.balanceCachePrefix}${address}:${tokenAddress}:${block}`;
  }

  /**
   * Create chain context for contract calls
   */
  private createChainContext(): ChainContext {
    return {
      _chain: {
        client: {
          call: async (method: string, params: unknown[]) => {
            // Handle block parameter in eth_call
            if (method === 'eth_call' && Array.isArray(params) && params.length >= 2) {
              const [callData, blockParam] = params;
              // If block is 0 or looks like a very old block, use 'latest'
              if (typeof blockParam === 'string' && (blockParam === '0x0' || parseInt(blockParam, 16) < 1000)) {
                params[1] = 'latest';
              }
            }
            return this.rpcClient.call(method, params);
          }
        }
      }
    } as ChainContext;
  }

    /**
   * Generic fallback method: Query token balances individually (when multicall is not available)
   */
    private async queryBalancesIndividually<T extends typeof erc20 | typeof erc721>(
      address: string,
      tokenAddresses: string[],
      tokenType: TokenType,
      contractModule: T,
      options: BalanceQueryOptions
    ): Promise<(TokenBalance | null)[]> {
      const context = this.createChainContext();
      const block = this.createBlock(options.blockNumber);
  
      const results = await Promise.all(
        tokenAddresses.map(async (tokenAddress) => {
          try {
            const contract = new contractModule.Contract(context, block, tokenAddress);
            const balance = await contract.balanceOf(address);
  
            if (!balance || balance === 0n) {
              return null;
            }
  
            let metadata: { name?: string; symbol?: string; decimals?: number } | undefined;
  
            if (options.includeMetadata) {
              try {
                const metadataPromises: Promise<any>[] = [
                  contract.name().catch(() => undefined),
                  contract.symbol().catch(() => undefined)
                ];
  
                // ERC20 has decimals, ERC721 doesn't
                if (tokenType === TokenType.ERC20) {
                  metadataPromises.push((contract as any).decimals().catch(() => undefined));
                }
  
                const metadataResults = await Promise.all(metadataPromises);
  
                metadata = {
                  name: metadataResults[0],
                  symbol: metadataResults[1],
                  decimals: tokenType === TokenType.ERC20 && metadataResults[2] !== undefined
                    ? Number(metadataResults[2])
                    : undefined
                };
              } catch (err) {
                logger.debug('Failed to fetch token metadata', {
                  tokenAddress,
                  tokenType,
                  error: err instanceof Error ? err.message : 'Unknown error'
                });
              }
            }
  
            return {
              tokenAddress,
              balance,
              tokenType,
              metadata
            };
          } catch (error) {
            logger.debug('Failed to query individual token balance', {
              tokenAddress,
              tokenType,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
            return null;
          }
        })
      );
  
      return results;
    }

  /**
   * Create block object for contract calls
   */
  private createBlock(blockNumber?: number): Block {
    return {
      height: blockNumber || 0 // Will be handled as 'latest' in chain context
    } as Block;
  }
} 