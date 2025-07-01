import { ITokenMetadataFetcher, TokenMetadata, TokenMetadataOptions } from '../../interfaces/services/ITokenMetadataFetcher';
import { IRpcClient } from '../../interfaces/blockchain/IRpcClient';
import { TokenType } from '../../model';
import * as erc20 from '../../abi/ERC20';
import * as erc721 from '../../abi/ERC721';
import * as erc1155 from '../../abi/ERC1155';
import { Multicall, MulticallResult } from '../../abi/multicall';
import { ChainContext, Block } from '../../abi/abi.support';
import { logger } from '../../utils/logger';

/**
 * Optimized token metadata fetcher using Multicall to batch RPC calls
 * Reduces the number of RPC requests significantly
 */
export class MulticallTokenMetadataFetcher implements ITokenMetadataFetcher {
  private static readonly MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
  
  constructor(private readonly rpcClient: IRpcClient) {}

  public async fetchMetadata(
    address: string, 
    tokenType: TokenType, 
    options?: TokenMetadataOptions
  ): Promise<TokenMetadata> {
    const blockNumber = options?.blockNumber;
    
    // Skip contract check if explicitly requested (for token enrichment)
    if (!options?.skipContractCheck) {
      const contractExists = await this.contractExists(address, blockNumber);
      
      if (!contractExists) {
        return { contractExists: false };
      }
    }

    const metadata: TokenMetadata = { contractExists: true };

    try {
      switch (tokenType) {
        case TokenType.ERC20:
          return await this.fetchERC20MetadataWithMulticall(address, blockNumber, metadata);
          
        case TokenType.ERC721:
          return await this.fetchERC721MetadataWithMulticall(address, blockNumber, metadata);
          
        case TokenType.ERC1155:
          return await this.fetchERC1155MetadataWithMulticall(address, blockNumber, metadata);
          
        default:
          logger.warn('Unknown token type for metadata fetch', { address, tokenType });
          return metadata;
      }
    } catch (error) {
      logger.debug('Multicall metadata fetch failed, falling back to individual calls', {
        address,
        tokenType,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      
      // Fallback to individual calls if multicall fails
      return this.fallbackToIndividualCalls(address, tokenType, metadata, blockNumber);
    }
  }

  public async contractExists(address: string, blockNumber?: number): Promise<boolean> {
    try {
      const code = await this.rpcClient.getCode(address, blockNumber || 'latest');
      return Boolean(code && code !== '0x' && code.length > 2);
    } catch (error) {
      logger.debug('Contract existence check failed', {
        address,
        blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  private async fetchERC20MetadataWithMulticall(
    address: string, 
    blockNumber: number | undefined, 
    metadata: TokenMetadata
  ): Promise<TokenMetadata> {
    const context = this.createChainContext();
    const block = this.createBlock(blockNumber);
    const multicall = new Multicall(context, block, MulticallTokenMetadataFetcher.MULTICALL3_ADDRESS);

    // Prepare all ERC20 function calls for multicall
    const calls: [any, string, any[]][] = [
      [erc20.functions.name, address, []],
      [erc20.functions.symbol, address, []],
      [erc20.functions.decimals, address, []],
      [erc20.functions.totalSupply, address, []]
    ];

    try {
      const results: MulticallResult<any>[] = await multicall.tryAggregate(calls);
      
      // Process results
      const [nameResult, symbolResult, decimalsResult, totalSupplyResult] = results;
      
      if (nameResult.success && nameResult.value) {
        metadata.name = nameResult.value;
      }
      
      if (symbolResult.success && symbolResult.value) {
        metadata.symbol = symbolResult.value;
      }
      
      if (decimalsResult.success && decimalsResult.value !== null) {
        metadata.decimals = Number(decimalsResult.value);
      }
      
      if (totalSupplyResult.success && totalSupplyResult.value !== null) {
        metadata.totalSupply = totalSupplyResult.value;
      }

      metadata.processed = true;
      
      logger.debug('ERC20 metadata fetched via multicall', {
        address,
        hasName: !!metadata.name,
        hasSymbol: !!metadata.symbol,
        hasDecimals: typeof metadata.decimals === 'number',
        hasTotalSupply: !!metadata.totalSupply,
        processed: true,
        successfulCalls: results.filter(r => r.success).length,
        totalCalls: results.length
      });

      return metadata;
    } catch (error) {
      logger.debug('ERC20 multicall failed', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async fetchERC721MetadataWithMulticall(
    address: string, 
    blockNumber: number | undefined, 
    metadata: TokenMetadata
  ): Promise<TokenMetadata> {
    const context = this.createChainContext();
    const block = this.createBlock(blockNumber);
    const multicall = new Multicall(context, block, MulticallTokenMetadataFetcher.MULTICALL3_ADDRESS);

    // Prepare ERC721 function calls for multicall
    const calls: [any, string, any[]][] = [
      [erc721.functions.name, address, []],
      [erc721.functions.symbol, address, []]
    ];

    try {
      const results: MulticallResult<any>[] = await multicall.tryAggregate(calls);
      
      // Process results
      const [nameResult, symbolResult] = results;
      
      if (nameResult.success && nameResult.value) {
        metadata.name = nameResult.value;
      }
      
      if (symbolResult.success && symbolResult.value) {
        metadata.symbol = symbolResult.value;
      }

      metadata.processed = true;
      
      logger.debug('ERC721 metadata fetched via multicall', {
        address,
        hasName: !!metadata.name,
        hasSymbol: !!metadata.symbol,
        processed: true,
        successfulCalls: results.filter(r => r.success).length,
        totalCalls: results.length
      });

      return metadata;
    } catch (error) {
      logger.debug('ERC721 multicall failed', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async fetchERC1155MetadataWithMulticall(
    address: string, 
    blockNumber: number | undefined, 
    metadata: TokenMetadata
  ): Promise<TokenMetadata> {
    const context = this.createChainContext();
    const block = this.createBlock(blockNumber);
    const multicall = new Multicall(context, block, MulticallTokenMetadataFetcher.MULTICALL3_ADDRESS);

    // Prepare ERC1155 function calls for multicall
    const calls: [any, string, any[]][] = [
      [erc1155.functions.uri, address, [0n]] // tokenId 0 for ERC1155 uri
    ];

    try {
      const results: MulticallResult<any>[] = await multicall.tryAggregate(calls);
      
      // Process results
      const [uriResult] = results;
      
      if (uriResult.success && uriResult.value) {
        logger.debug('ERC1155 metadata fetched via multicall', { 
          address, 
          uri: uriResult.value 
        });
      }

      metadata.processed = true;
      
      logger.debug('ERC1155 metadata fetched via multicall', {
        address,
        processed: true,
        successfulCalls: results.filter(r => r.success).length,
        totalCalls: results.length
      });

      return metadata;
    } catch (error) {
      logger.debug('ERC1155 multicall failed', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async fallbackToIndividualCalls(
    address: string, 
    tokenType: TokenType, 
    metadata: TokenMetadata, 
    blockNumber?: number
  ): Promise<TokenMetadata> {
    const context = this.createChainContext();
    const block = this.createBlock(blockNumber);

    try {
      switch (tokenType) {
        case TokenType.ERC20: {
          const contract = new erc20.Contract(context, block, address);
          const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
            this.safeCall(() => contract.name()),
            this.safeCall(() => contract.symbol()),
            this.safeCall(() => contract.decimals()),
            this.safeCall(() => contract.totalSupply()),
          ]);

          if (name.status === 'fulfilled' && name.value) metadata.name = name.value;
          if (symbol.status === 'fulfilled' && symbol.value) metadata.symbol = symbol.value;
          if (decimals.status === 'fulfilled' && decimals.value !== null) {
            metadata.decimals = Number(decimals.value);
          }
          if (totalSupply.status === 'fulfilled' && totalSupply.value !== null) {
            metadata.totalSupply = totalSupply.value;
          }
          break;
        }
        
        case TokenType.ERC721: {
          const contract = new erc721.Contract(context, block, address);
          const [name, symbol] = await Promise.allSettled([
            this.safeCall(() => contract.name()),
            this.safeCall(() => contract.symbol()),
          ]);

          if (name.status === 'fulfilled' && name.value) metadata.name = name.value;
          if (symbol.status === 'fulfilled' && symbol.value) metadata.symbol = symbol.value;
          break;
        }
        
        case TokenType.ERC1155: {
          const contract = new erc1155.Contract(context, block, address);
          const uri = await this.safeCall(() => contract.uri(0n));
          if (uri) {
            logger.debug('ERC1155 fallback metadata fetched', { address, uri });
          }
          break;
        }
      }

      metadata.processed = true;
      
      logger.debug('Fallback metadata fetch completed', {
        address,
        tokenType,
        hasName: !!metadata.name,
        hasSymbol: !!metadata.symbol,
        hasDecimals: typeof metadata.decimals === 'number',
        hasTotalSupply: !!metadata.totalSupply,
        processed: true
      });

      return metadata;
    } catch (error) {
      logger.debug('Fallback metadata fetch failed', {
        address,
        tokenType,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      metadata.processed = true; // Mark as processed even if failed
      return metadata;
    }
  }

  private async safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error && error.message.includes('execution reverted')) {
        // Normal - method not supported
        return null;
      }
      
      logger.debug('Metadata call failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  private createChainContext(): ChainContext {
    return {
      _chain: {
        client: this.rpcClient,
      },
    };
  }

  private createBlock(blockNumber?: number): Block {
    return {
      height: blockNumber || 23640000, // Use recent block instead of 0
    };
  }
} 