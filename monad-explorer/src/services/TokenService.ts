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
   * Detects token type by checking standard interfaces
   */
  async detectTokenType(tokenAddress: string): Promise<TokenDetectionResult> {
    const result: TokenDetectionResult = {
      isERC20: false,
      isERC721: false,
      isERC1155: false,
      supportedInterfaces: []
    };

    try {
      const erc165Contract = new erc165.Contract(this.context, this.block, tokenAddress);
      
      // Check if contract supports ERC165
      const supportsERC165 = await this.safeCall(() => 
        erc165Contract.supportsInterface(erc165.functions.supportsInterface.sighash)
      );
      
      if (supportsERC165) {
        // Get standard interface IDs from the generated functions
        const interfaceChecks = await Promise.allSettled([
          this.safeCall(() => erc165Contract.supportsInterface(this.getERC20InterfaceId())),
          this.safeCall(() => erc165Contract.supportsInterface(this.getERC721InterfaceId())),
          this.safeCall(() => erc165Contract.supportsInterface(this.getERC1155InterfaceId()))
        ]);

        result.isERC20 = this.getSettledValue(interfaceChecks[0]) || false;
        result.isERC721 = this.getSettledValue(interfaceChecks[1]) || false;
        result.isERC1155 = this.getSettledValue(interfaceChecks[2]) || false;
      } else {
        // Fallback: Try ERC20 methods directly
        result.isERC20 = await this.tryERC20Methods(tokenAddress);
      }

      // Build supported interfaces list
      if (result.isERC20) result.supportedInterfaces.push('ERC20');
      if (result.isERC721) result.supportedInterfaces.push('ERC721');
      if (result.isERC1155) result.supportedInterfaces.push('ERC1155');

      logger.info('Token type detection completed', {
        address: tokenAddress,
        interfaces: result.supportedInterfaces
      });

      return result;
    } catch (error) {
      logger.error('Token type detection failed', {
        address: tokenAddress,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return result;
    }
  }

  /**
   * Fetches complete token metadata using generated contracts
   */
  async fetchTokenMetadata(tokenAddress: string): Promise<TokenMetadata | null> {
    try {
      const detection = await this.detectTokenType(tokenAddress);
      
      if (detection.isERC1155) {
        return await this.fetchERC1155Metadata(tokenAddress);
      } else if (detection.isERC721) {
        return await this.fetchERC721Metadata(tokenAddress);
      } else if (detection.isERC20) {
        return await this.fetchERC20Metadata(tokenAddress);
      }

      logger.warn('Unknown token type', { address: tokenAddress });
      return null;
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

  private async tryERC20Methods(tokenAddress: string): Promise<boolean> {
    try {
      const erc20Contract = new erc20.Contract(this.context, this.block, tokenAddress);
      await erc20Contract.name();
      return true;
    } catch {
      return false;
    }
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
      name: this.getSettledValue(name) || 'Unknown',
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
      tokenType: TokenType.ERC721
    };
  }

  private async fetchERC1155Metadata(tokenAddress: string): Promise<TokenMetadata> {
    // ERC1155 doesn't have standard name/symbol methods
    // Could try to get URI for tokenId 0 or check for common extensions
    return {
      name: 'ERC1155 Token',
      symbol: 'ERC1155',
      tokenType: TokenType.ERC1155
    };
  }

  /**
   * Get ERC20 interface ID from function signatures
   */
  private getERC20InterfaceId(): string {
    // Calculate ERC20 interface ID from function selectors
    const selectors = [
      erc20.functions.name.sighash,
      erc20.functions.symbol.sighash,
      erc20.functions.decimals.sighash,
      erc20.functions.totalSupply.sighash,
      erc20.functions.balanceOf.sighash,
      erc20.functions.transfer.sighash,
      erc20.functions.transferFrom.sighash,
      erc20.functions.approve.sighash,
      erc20.functions.allowance.sighash
    ];
    
    return this.calculateInterfaceId(selectors);
  }

  /**
   * Get ERC721 interface ID from function signatures
   */
  private getERC721InterfaceId(): string {
    const selectors = [
      erc721.functions.balanceOf.sighash,
      erc721.functions.ownerOf.sighash,
      erc721.functions.transferFrom.sighash,
      erc721.functions.approve.sighash,
      erc721.functions.getApproved.sighash,
      erc721.functions.setApprovalForAll.sighash,
      erc721.functions.isApprovedForAll.sighash
    ];
    
    return this.calculateInterfaceId(selectors);
  }

  /**
   * Get ERC1155 interface ID from function signatures
   */
  private getERC1155InterfaceId(): string {
    const selectors = [
      erc1155.functions.balanceOf.sighash,
      erc1155.functions.balanceOfBatch.sighash,
      erc1155.functions.setApprovalForAll.sighash,
      erc1155.functions.isApprovedForAll.sighash,
      erc1155.functions.safeTransferFrom.sighash
    ];
    
    return this.calculateInterfaceId(selectors);
  }

  /**
   * Calculate interface ID by XORing function selectors
   */
  private calculateInterfaceId(selectors: string[]): string {
    let interfaceId = 0;
    
    for (const selector of selectors) {
      const selectorInt = parseInt(selector.slice(2), 16);
      interfaceId ^= selectorInt;
    }
    
    return `0x${interfaceId.toString(16).padStart(8, '0')}`;
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
} 