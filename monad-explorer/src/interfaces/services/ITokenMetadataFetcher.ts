import { TokenType } from '../../model';

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  contractExists: boolean;
  processed?: boolean;
}

export interface ITokenMetadataFetcher {
  /**
   * Fetch token metadata based on token type
   */
  fetchMetadata(address: string, tokenType: TokenType, blockNumber?: number): Promise<TokenMetadata>;
  
  /**
   * Check if contract exists
   */
  contractExists(address: string, blockNumber?: number): Promise<boolean>;
} 