import { TokenType } from '../../model';

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals?: number;
  totalSupply?: bigint;
  tokenType: TokenType;
  uri?: string; // For ERC721/ERC1155
  description?: string;
  image?: string;
  external_url?: string;
  attributes?: Record<string, unknown>[];
}

export interface MetadataFetchOptions {
  blockNumber?: number;
  timeout?: number;
  includeExtendedMetadata?: boolean;
  tokenId?: bigint; // For ERC721/ERC1155 specific metadata
}

export interface MetadataValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ITokenMetadataService {
  /**
   * Fetch complete token metadata
   */
  fetchMetadata(
    tokenAddress: string,
    tokenType: TokenType,
    options?: MetadataFetchOptions
  ): Promise<TokenMetadata | null>;

  /**
   * Fetch basic ERC20 metadata
   */
  fetchERC20Metadata(
    tokenAddress: string,
    options?: MetadataFetchOptions
  ): Promise<Omit<TokenMetadata, 'uri' | 'image' | 'external_url' | 'attributes'>>;

  /**
   * Fetch ERC721 metadata with URI resolution
   */
  fetchERC721Metadata(
    tokenAddress: string,
    tokenId?: bigint,
    options?: MetadataFetchOptions
  ): Promise<TokenMetadata>;

  /**
   * Fetch ERC1155 metadata
   */
  fetchERC1155Metadata(
    tokenAddress: string,
    tokenId?: bigint,
    options?: MetadataFetchOptions
  ): Promise<TokenMetadata>;

  /**
   * Resolve token URI to metadata JSON
   */
  resolveTokenURI(
    uri: string,
    tokenId?: bigint,
    timeout?: number
  ): Promise<Record<string, unknown> | null>;

  /**
   * Validate fetched metadata
   */
  validateMetadata(
    metadata: Partial<TokenMetadata>,
    tokenType: TokenType
  ): MetadataValidationResult;

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    cacheSize: number;
    hitRate: number;
    missCount: number;
    errorCount: number;
  };

  /**
   * Clear metadata cache
   */
  clearCache(): void;
} 