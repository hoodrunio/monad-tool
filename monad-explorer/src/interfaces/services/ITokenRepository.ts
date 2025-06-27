import { TokenType } from '../../model';

export interface TokenInfo {
  address: string;
  type: TokenType;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITokenRepository {
  /**
   * Check if token exists in database
   */
  exists(address: string): Promise<boolean>;
  
  /**
   * Get token info from database
   */
  get(address: string): Promise<TokenInfo | null>;
  
  /**
   * Save token info to database
   */
  save(tokenInfo: TokenInfo): Promise<void>;
  
  /**
   * Update token info
   */
  update(address: string, updates: Partial<TokenInfo>): Promise<void>;
  
  /**
   * Get multiple tokens
   */
  getMany(addresses: string[]): Promise<TokenInfo[]>;
} 