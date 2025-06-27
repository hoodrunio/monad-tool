import { ITokenRepository, TokenInfo } from '../../interfaces/services/ITokenRepository';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { logger } from '../../utils/logger';

/**
 * Redis-based token repository
 * Uses Redis for fast token lookup and persistence
 */
export class RedisTokenRepository implements ITokenRepository {
  private readonly keyPrefix = 'token:';
  private readonly existsKeyPrefix = 'token_exists:';

  constructor(private readonly cache: ICacheService) {}

  async exists(address: string): Promise<boolean> {
    const key = this.existsKeyPrefix + address.toLowerCase();
    return await this.cache.has(key);
  }

  async get(address: string): Promise<TokenInfo | null> {
    const key = this.keyPrefix + address.toLowerCase();
    const serialized = await this.cache.get<any>(key);
    
    if (!serialized) {
      return null;
    }
    
    // Deserialize BigInt values back from strings
    return this.deserializeTokenInfo(serialized);
  }

  async save(tokenInfo: TokenInfo): Promise<void> {
    const normalizedAddress = tokenInfo.address.toLowerCase();
    const tokenKey = this.keyPrefix + normalizedAddress;
    const existsKey = this.existsKeyPrefix + normalizedAddress;

    // Convert BigInt to string for Redis serialization
    const serializedTokenInfo = this.serializeTokenInfo(tokenInfo);

    // Save token info (TTL: 24 hours)
    await this.cache.set(tokenKey, serializedTokenInfo, 24 * 60 * 60 * 1000);
    
    // Mark as exists (TTL: 7 days)
    await this.cache.set(existsKey, true, 7 * 24 * 60 * 60 * 1000);

    logger.debug('Token saved to Redis repository', {
      address: normalizedAddress,
      type: tokenInfo.type,
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
    });
  }

  async update(address: string, updates: Partial<TokenInfo>): Promise<void> {
    const existing = await this.get(address);
    if (!existing) {
      logger.warn('Cannot update non-existent token', { address });
      return;
    }

    const updated: TokenInfo = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };

    await this.save(updated);
  }

  async getMany(addresses: string[]): Promise<TokenInfo[]> {
    const keys = addresses.map(addr => this.keyPrefix + addr.toLowerCase());
    const results = await this.cache.getMultiple<any>(keys);
    
    return results
      .filter((item): item is any => item !== null)
      .map(item => this.deserializeTokenInfo(item));
  }

  /**
   * Convert BigInt values to strings for Redis serialization
   */
  private serializeTokenInfo(tokenInfo: TokenInfo): any {
    return {
      ...tokenInfo,
      totalSupply: tokenInfo.totalSupply ? tokenInfo.totalSupply.toString() : undefined,
      createdAt: tokenInfo.createdAt.toISOString(),
      updatedAt: tokenInfo.updatedAt.toISOString(),
    };
  }

  /**
   * Convert string values back to BigInt for application use
   */
  private deserializeTokenInfo(serialized: any): TokenInfo {
    return {
      ...serialized,
      totalSupply: serialized.totalSupply ? BigInt(serialized.totalSupply) : undefined,
      createdAt: new Date(serialized.createdAt),
      updatedAt: new Date(serialized.updatedAt),
    };
  }
} 