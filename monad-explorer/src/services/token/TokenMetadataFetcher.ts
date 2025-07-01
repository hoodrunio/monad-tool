import { ITokenMetadataFetcher, TokenMetadata, TokenMetadataOptions } from '../../interfaces/services/ITokenMetadataFetcher';
import { IRpcClient } from '../../interfaces/blockchain/IRpcClient';
import { TokenType } from '../../model';
import * as erc20 from '../../abi/ERC20';
import * as erc721 from '../../abi/ERC721';
import * as erc1155 from '../../abi/ERC1155';
import { ChainContext, Block } from '../../abi/abi.support';
import { logger } from '../../utils/logger';

/**
 * Fetches token metadata using RPC calls
 * Only called when token is not in database
 */
export class TokenMetadataFetcher implements ITokenMetadataFetcher {
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
          return await this.fetchERC20Metadata(address, blockNumber, metadata);
          
        case TokenType.ERC721:
          return await this.fetchERC721Metadata(address, blockNumber, metadata);
          
        case TokenType.ERC1155:
          return await this.fetchERC1155Metadata(address, blockNumber, metadata);
          
        default:
          logger.warn('Unknown token type for metadata fetch', { address, tokenType });
          return metadata;
      }
    } catch (error) {
      logger.debug('Metadata fetch failed', {
        address,
        tokenType,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return metadata;
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

  private async fetchERC20Metadata(
    address: string, 
    blockNumber: number | undefined, 
    metadata: TokenMetadata
  ): Promise<TokenMetadata> {
    const context = this.createChainContext();
    const block = this.createBlock(blockNumber);
    const contract = new erc20.Contract(context, block, address);

    // Fetch ERC20 metadata in parallel
    const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
      this.safeCall(() => contract.name()),
      this.safeCall(() => contract.symbol()),
      this.safeCall(() => contract.decimals()),
      this.safeCall(() => contract.totalSupply()),
    ]);

    if (name.status === 'fulfilled' && name.value) {
      metadata.name = name.value;
    }
    
    if (symbol.status === 'fulfilled' && symbol.value) {
      metadata.symbol = symbol.value;
    }
    
    if (decimals.status === 'fulfilled' && decimals.value !== null) {
      metadata.decimals = Number(decimals.value);
    }
    
    if (totalSupply.status === 'fulfilled' && totalSupply.value !== null) {
      metadata.totalSupply = totalSupply.value;
    }

    // Mark as processed regardless of what metadata was found
    metadata.processed = true;
    
    logger.debug('ERC20 metadata fetched', {
      address,
      hasName: !!metadata.name,
      hasSymbol: !!metadata.symbol,
      hasDecimals: typeof metadata.decimals === 'number',
      hasTotalSupply: !!metadata.totalSupply,
      processed: true
    });

    return metadata;
  }

  private async fetchERC721Metadata(
    address: string, 
    blockNumber: number | undefined, 
    metadata: TokenMetadata
  ): Promise<TokenMetadata> {
    const context = this.createChainContext();
    const block = this.createBlock(blockNumber);
    const contract = new erc721.Contract(context, block, address);

    // Fetch ERC721 metadata in parallel
    const [name, symbol] = await Promise.allSettled([
      this.safeCall(() => contract.name()),
      this.safeCall(() => contract.symbol()),
    ]);

    if (name.status === 'fulfilled' && name.value) {
      metadata.name = name.value;
    }
    
    if (symbol.status === 'fulfilled' && symbol.value) {
      metadata.symbol = symbol.value;
    }

    // Mark as processed even if name/symbol are missing (optional for ERC721)
    metadata.processed = true;
    
    logger.debug('ERC721 metadata fetched', {
      address,
      hasName: !!metadata.name,
      hasSymbol: !!metadata.symbol,
      processed: true
    });

    return metadata;
  }

  private async fetchERC1155Metadata(
    address: string, 
    blockNumber: number | undefined, 
    metadata: TokenMetadata
  ): Promise<TokenMetadata> {
    const context = this.createChainContext();
    const block = this.createBlock(blockNumber);
    const contract = new erc1155.Contract(context, block, address);

    try {
      // ERC1155 doesn't have standard name/symbol, but has uri
      const uri = await this.safeCall(() => contract.uri(0n));
      if (uri) {
        // Could extract name from URI if needed
        logger.debug('ERC1155 metadata fetched', { address, uri });
      }
    } catch (error) {
      logger.debug('ERC1155 metadata fetch failed', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Mark as processed even if no standard metadata available
    metadata.processed = true;
    
    logger.debug('ERC1155 metadata fetched', {
      address,
      processed: true
    });

    return metadata;
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