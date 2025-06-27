import { Store } from '@subsquid/typeorm-store';
import { Token, TokenType } from '../model';
import * as erc20 from '../abi/ERC20';
import * as erc721 from '../abi/ERC721';
import * as erc1155 from '../abi/ERC1155';
import * as erc165 from '../abi/ERC165';
import { ChainContext, Block } from '../abi/abi.support';
import { logger } from '../utils/logger';

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals?: number;
  totalSupply?: bigint;
  tokenType: TokenType;
}

export interface TokenDetectionResult {
  isERC20: boolean;
  isERC721: boolean;
  isERC1155: boolean;
  supportedInterfaces: string[];
}

interface RpcClient {
  call<T = any>(method: string, params?: unknown[]): Promise<T>;
}

/**
 * Production-ready TokenService that uses generated ABI interfaces
 * Works with both Subsquid processor context and standalone RPC client
 */
export class TokenService {
  private readonly context: ChainContext;
  private readonly block: Block;
  // Cache for metadata to avoid duplicate RPC calls within same service instance
  private metadataCache = new Map<string, TokenMetadata>();

  // Standard ERC interface IDs (EIP-165)
  private static readonly ERC165_INTERFACE_ID = '0x01ffc9a7';
  private static readonly ERC20_INTERFACE_ID = '0x36372b07';   // Real ERC20 interface ID
  private static readonly ERC721_INTERFACE_ID = '0x80ac58cd';  // Real ERC721 interface ID  
  private static readonly ERC1155_INTERFACE_ID = '0xd9b67a26'; // Real ERC1155 interface ID

  constructor(context: ChainContext, block: Block) {
    this.context = context;
    this.block = block;
  }

  /**
   * Static factory for standalone usage with RPC client
   */
  static createStandalone(rpcClient: RpcClient, blockNumber: number): TokenService {
    const chainContext: ChainContext = {
      _chain: {
        client: rpcClient
      }
    };
    
    const block: Block = {
      height: blockNumber
    };

    return new TokenService(chainContext, block);
  }

  /**
   * Enhanced token type detection with proper interface checking and fallback strategies
   */
  async detectTokenType(tokenAddress: string): Promise<TokenDetectionResult> {
    const result: TokenDetectionResult = {
      isERC20: false,
      isERC721: false,
      isERC1155: false,
      supportedInterfaces: []
    };

    try {
      // First, check if contract actually exists at this block height
      const contractExists = await this.checkContractExistence(tokenAddress);
      if (!contractExists) {
        logger.debug('Contract does not exist at current block, skipping detection', { 
          address: tokenAddress,
          blockHeight: this.block.height
        });
        return result;
      }

      const erc165Contract = new erc165.Contract(this.context, this.block, tokenAddress);
      
      // First, check if contract supports ERC165
      let supportsERC165 = false;
      try {
        supportsERC165 = await this.safeCall(() => 
          erc165Contract.supportsInterface(TokenService.ERC165_INTERFACE_ID)
        ) || false;
      } catch (error) {
        logger.debug('ERC165 check failed, trying fallback detection', { 
          address: tokenAddress,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      
      if (supportsERC165) {
        // Use ERC165 interface detection
        logger.debug('Contract supports ERC165, checking interfaces', { address: tokenAddress });
        
        const interfaceChecks = await Promise.allSettled([
          this.safeCall(() => erc165Contract.supportsInterface(TokenService.ERC20_INTERFACE_ID)),
          this.safeCall(() => erc165Contract.supportsInterface(TokenService.ERC721_INTERFACE_ID)),
          this.safeCall(() => erc165Contract.supportsInterface(TokenService.ERC1155_INTERFACE_ID))
        ]);

        result.isERC20 = this.getSettledValue(interfaceChecks[0]) || false;
        result.isERC721 = this.getSettledValue(interfaceChecks[1]) || false;
        result.isERC1155 = this.getSettledValue(interfaceChecks[2]) || false;

        // Build supported interfaces list
        if (result.isERC20) result.supportedInterfaces.push('ERC20');
        if (result.isERC721) result.supportedInterfaces.push('ERC721');
        if (result.isERC1155) result.supportedInterfaces.push('ERC1155');
      } else {
        // Fallback: Try method calls directly to detect token type
        logger.debug('ERC165 not supported, using fallback detection', { address: tokenAddress });
        
        // Test ERC20 methods with empty data detection
        result.isERC20 = await this.tryERC20MethodsWithEmptyDataCheck(tokenAddress);
        
        // Test ERC721 methods (only if not ERC20)
        if (!result.isERC20) {
          result.isERC721 = await this.tryERC721MethodsWithEmptyDataCheck(tokenAddress);
        }
        
        // Test ERC1155 methods (only if not ERC20 or ERC721)
        if (!result.isERC20 && !result.isERC721) {
          result.isERC1155 = await this.tryERC1155MethodsWithEmptyDataCheck(tokenAddress);
        }

        // Build supported interfaces list based on successful method calls
        if (result.isERC20) result.supportedInterfaces.push('ERC20');
        if (result.isERC721) result.supportedInterfaces.push('ERC721');
        if (result.isERC1155) result.supportedInterfaces.push('ERC1155');
      }

      logger.info('Token type detection completed', {
        address: tokenAddress,
        interfaces: result.supportedInterfaces,
        usedERC165: supportsERC165,
        blockHeight: this.block.height
      });

      return result;
    } catch (error) {
      logger.error('Token type detection failed completely', {
        address: tokenAddress,
        blockHeight: this.block.height,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return result;
    }
  }

  /**
   * Check if contract exists at the current block height
   */
  private async checkContractExistence(tokenAddress: string): Promise<boolean> {
    try {
      // Try to get contract code at current block
      if (this.context._chain.client?.call) {
        const blockTag = this.block.height ? `0x${this.block.height.toString(16)}` : 'latest';
        const code = await this.context._chain.client.call('eth_getCode', [tokenAddress, blockTag]);
        
        const exists = code && code !== '0x' && code.length > 2;
        
        if (!exists) {
          logger.debug('Contract does not exist at block', {
            address: tokenAddress,
            blockHeight: this.block.height,
            blockTag,
            codeLength: code?.length || 0
          });
        }
        
        return exists;
      }
    } catch (error) {
      logger.debug('Contract existence check failed', {
        address: tokenAddress,
        blockHeight: this.block.height,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
    
    // If we can't check, assume it exists to avoid false negatives
    return true;
  }

  /**
   * Test ERC20 methods with empty data detection
   */
  private async tryERC20MethodsWithEmptyDataCheck(tokenAddress: string): Promise<boolean> {
    try {
      const erc20Contract = new erc20.Contract(this.context, this.block, tokenAddress);
      
      // Try essential ERC20 methods
      const results = await Promise.allSettled([
        this.safeCallWithEmptyDataCheck(() => erc20Contract.name()),
        this.safeCallWithEmptyDataCheck(() => erc20Contract.symbol()),
        this.safeCallWithEmptyDataCheck(() => erc20Contract.decimals()),
        this.safeCallWithEmptyDataCheck(() => erc20Contract.totalSupply())
      ]);
      
      // Consider it ERC20 if at least 2 essential methods work (not empty data)
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value !== null && r.value !== undefined).length;
      
      if (successCount >= 2) {
        logger.debug('ERC20 detection successful', {
          address: tokenAddress,
          successfulMethods: successCount,
          blockHeight: this.block.height
        });
      }
      
      return successCount >= 2;
    } catch {
      return false;
    }
  }

  /**
   * Test ERC721 methods with empty data detection
   */
  private async tryERC721MethodsWithEmptyDataCheck(tokenAddress: string): Promise<boolean> {
    try {
      const erc721Contract = new erc721.Contract(this.context, this.block, tokenAddress);
      
      // Try essential ERC721 methods
      const results = await Promise.allSettled([
        this.safeCallWithEmptyDataCheck(() => erc721Contract.name()),
        this.safeCallWithEmptyDataCheck(() => erc721Contract.symbol())
      ]);
      
      // Consider it ERC721 if both name and symbol work (not empty data)
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value !== null && r.value !== undefined).length;
      
      if (successCount >= 2) {
        logger.debug('ERC721 detection successful', {
          address: tokenAddress,
          successfulMethods: successCount,
          blockHeight: this.block.height
        });
      }
      
      return successCount >= 2;
    } catch {
      return false;
    }
  }

  /**
   * Test ERC1155 methods with empty data detection
   */
  private async tryERC1155MethodsWithEmptyDataCheck(tokenAddress: string): Promise<boolean> {
    try {
      const erc1155Contract = new erc1155.Contract(this.context, this.block, tokenAddress);
      
      // Try ERC1155 uri method
      const uri = await this.safeCallWithEmptyDataCheck(() => erc1155Contract.uri(0n));
      
      const hasValidUri = uri !== null && uri !== undefined && typeof uri === 'string' && uri.length > 0;
      
      if (hasValidUri) {
        logger.debug('ERC1155 detection successful', {
          address: tokenAddress,
          uri: uri,
          blockHeight: this.block.height
        });
      }
      
      return hasValidUri;
    } catch {
      return false;
    }
  }

  /**
   * Safe wrapper for contract calls with empty data detection
   */
  private async safeCallWithEmptyDataCheck<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      const result = await fn();
      
      // Check for common "empty" results that indicate contract not ready
      if (result === null || result === undefined) {
        return null;
      }
      
      // For string results, check if it's empty or just whitespace
      if (typeof result === 'string' && result.trim().length === 0) {
        return null;
      }
      
      // For numeric results, they should be valid
      if (typeof result === 'number' || typeof result === 'bigint') {
        return result;
      }
      
      return result;
    } catch (error) {
      // Check if it's the specific "could not decode result data" error
      if (error instanceof Error && error.message.includes('could not decode result data')) {
        logger.debug('Empty data detected - contract not ready at this block', {
          error: error.message
        });
        return null;
      }
      
      // Other errors might indicate the method doesn't exist
      logger.debug('Contract call failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Fetches complete token metadata using generated contracts
   */
  async fetchTokenMetadata(tokenAddress: string): Promise<TokenMetadata | null> {
    // Check cache first
    const cached = this.metadataCache.get(tokenAddress);
    if (cached) {
      logger.debug('Token metadata served from cache', { address: tokenAddress });
      return cached;
    }

    try {
      const detection = await this.detectTokenType(tokenAddress);
      
      let metadata: TokenMetadata | null = null;
      
      // Prioritize detection based on supported interfaces
      if (detection.isERC1155) {
        metadata = await this.fetchERC1155Metadata(tokenAddress);
      } else if (detection.isERC721) {
        metadata = await this.fetchERC721Metadata(tokenAddress);
      } else if (detection.isERC20) {
        metadata = await this.fetchERC20Metadata(tokenAddress);
      }

      if (!metadata) {
        logger.warn('Unknown token type', { 
          address: tokenAddress,
          detectedInterfaces: detection.supportedInterfaces 
        });
        return null;
      }

      // Cache the result
      this.metadataCache.set(tokenAddress, metadata);
      logger.debug('Token metadata cached', { 
        address: tokenAddress,
        name: metadata.name,
        symbol: metadata.symbol,
        type: metadata.tokenType
      });

      return metadata;
    } catch (error) {
      logger.error('Failed to fetch token metadata', {
        address: tokenAddress,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Creates or updates token in database
   */
  async createOrUpdateToken(
    store: Store,
    tokenAddress: string,
    metadata: TokenMetadata
  ): Promise<Token> {
    let token = await store.get(Token, tokenAddress);
    
    if (!token) {
      token = new Token({
        id: tokenAddress,
        address: tokenAddress,
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals || null,
        totalSupply: metadata.totalSupply || null,
        tokenType: metadata.tokenType,
        createdAt: new Date()
      });

      logger.info('Creating new token', {
        address: tokenAddress,
        name: metadata.name,
        symbol: metadata.symbol,
        tokenType: metadata.tokenType
      });
    } else {
      // Update existing token
      token.name = metadata.name;
      token.symbol = metadata.symbol;
      token.decimals = metadata.decimals || token.decimals;
      token.totalSupply = metadata.totalSupply || token.totalSupply;
      token.tokenType = metadata.tokenType;

      logger.info('Updating existing token', {
        address: tokenAddress,
        name: metadata.name,
        symbol: metadata.symbol
      });
    }

    await store.save(token);
    return token;
  }

  private async fetchERC20Metadata(tokenAddress: string): Promise<TokenMetadata> {
    const erc20Contract = new erc20.Contract(this.context, this.block, tokenAddress);
    
    const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
      this.safeCall(() => erc20Contract.name()),
      this.safeCall(() => erc20Contract.symbol()),
      this.safeCall(() => erc20Contract.decimals()),
      this.safeCall(() => erc20Contract.totalSupply())
    ]);

    return {
      name: this.getSettledValue(name) || 'Unknown Token',
      symbol: this.getSettledValue(symbol) || 'UNKNOWN',
      decimals: this.getSettledValue(decimals) || 18,
      totalSupply: this.getSettledValue(totalSupply) || 0n,
      tokenType: TokenType.ERC20
    };
  }

  private async fetchERC721Metadata(tokenAddress: string): Promise<TokenMetadata> {
    const erc721Contract = new erc721.Contract(this.context, this.block, tokenAddress);
    
    const [name, symbol] = await Promise.allSettled([
      this.safeCall(() => erc721Contract.name()),
      this.safeCall(() => erc721Contract.symbol())
    ]);

    return {
      name: this.getSettledValue(name) || 'Unknown NFT',
      symbol: this.getSettledValue(symbol) || 'NFT',
      decimals: 0, // NFTs don't have decimals
      tokenType: TokenType.ERC721
    };
  }

  private async fetchERC1155Metadata(tokenAddress: string): Promise<TokenMetadata> {
    const erc1155Contract = new erc1155.Contract(this.context, this.block, tokenAddress);
    
    // Try to get URI for token ID 0
    const uri = await this.safeCall(() => erc1155Contract.uri(0n));
    
    // ERC1155 contracts might have name/symbol extensions, try them
    let name = 'Multi-Token';
    let symbol = 'ERC1155';
    
    try {
      // Some ERC1155 contracts implement name() and symbol() methods
      const erc20Contract = new erc20.Contract(this.context, this.block, tokenAddress);
      const nameResult = await this.safeCall(() => erc20Contract.name());
      const symbolResult = await this.safeCall(() => erc20Contract.symbol());
      
      if (nameResult && typeof nameResult === 'string' && nameResult.trim().length > 0) {
        name = nameResult;
      }
      
      if (symbolResult && typeof symbolResult === 'string' && symbolResult.trim().length > 0) {
        symbol = symbolResult;
      }
    } catch {
      // Ignore if name/symbol not available
    }

    return {
      name,
      symbol,
      decimals: 0, // Multi-tokens typically don't have decimals
      tokenType: TokenType.ERC1155
    };
  }

  /**
   * Safe wrapper for contract calls with error handling
   */
  private async safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      // Log error details for debugging
      logger.debug('Contract call failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  /**
   * Extract value from PromiseSettledResult
   */
  private getSettledValue<T>(result: PromiseSettledResult<T | null>): T | null {
    return result.status === 'fulfilled' ? result.value : null;
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      cacheSize: this.metadataCache.size,
      cachedTokens: Array.from(this.metadataCache.keys())
    };
  }

  /**
   * Clear metadata cache
   */
  clearCache(): void {
    this.metadataCache.clear();
  }
} 