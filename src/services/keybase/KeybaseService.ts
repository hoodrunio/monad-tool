import axios, { AxiosResponse } from 'axios';
import { logger } from '../../utils/logger';

export interface KeybaseProfile {
  id: string;
  username: string;
  full_name?: string;
  avatar_url?: string;
  bio?: string;
  location?: string;
  website?: string;
  twitter?: string;
  github?: string;
  verified: boolean;
}

export interface KeybaseApiProfile {
  id: string;
  basics: {
    username: string;
    ctime: number;
    mtime: number;
    id_version: number;
    track_version: number;
    last_id_change: number;
    username_cased: string;
    status: number;
    salt: string;
    eldest_seqno: number;
  };
  profile?: {
    mtime: number | null;
    full_name?: string;
    location?: string;
    bio?: string;
  };
  pictures?: {
    primary?: {
      url: string;
      source: string | null;
    };
  };
}

export interface KeybaseResponse {
  status: {
    code: number;
    name: string;
  };
  them?: KeybaseApiProfile[];
}

export interface KeybaseServiceConfig {
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  retryDelay: number;
  enableCaching: boolean;
  cacheTtl: number;
}

export class KeybaseService {
  private config: KeybaseServiceConfig;
  private cache: Map<string, { data: KeybaseProfile; timestamp: number }> = new Map();

  constructor(config: Partial<KeybaseServiceConfig> = {}) {
    this.config = {
      baseUrl: 'https://keybase.io/_/api/1.0',
      timeout: 10000,
      maxRetries: 3,
      retryDelay: 1000,
      enableCaching: true,
      cacheTtl: 24 * 60 * 60 * 1000, // 24 hours
      ...config
    };
  }

  /**
   * Get Keybase profile by username
   */
  async getProfile(username: string): Promise<KeybaseProfile | null> {
    try {
      // Check cache first
      if (this.config.enableCaching) {
        const cached = this.cache.get(username);
        if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
          logger.debug(`Cache hit for Keybase profile: ${username}`);
          return cached.data;
        }
      }

      // Fetch from API
      const profile = await this.fetchProfileWithRetry(username);
      
      if (profile && this.config.enableCaching) {
        this.cache.set(username, {
          data: profile,
          timestamp: Date.now()
        });
      }

      return profile;
    } catch (error) {
      logger.error(`Failed to get Keybase profile for ${username}:`, error);
      return null;
    }
  }

  /**
   * Get Keybase profile by key suffix (64-bit public key)
   */
  async getProfileByKeySuffix(keySuffix: string): Promise<KeybaseProfile | null> {
    try {
      // Check cache first
      if (this.config.enableCaching) {
        const cached = this.cache.get(keySuffix);
        if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
          logger.debug(`Cache hit for Keybase profile by key suffix: ${keySuffix}`);
          return cached.data;
        }
      }

      // Fetch from API using key_suffix
      const profile = await this.fetchProfileByKeySuffixWithRetry(keySuffix);
      
      if (profile && this.config.enableCaching) {
        this.cache.set(keySuffix, {
          data: profile,
          timestamp: Date.now()
        });
      }

      return profile;
    } catch (error) {
      logger.error(`Failed to get Keybase profile for key suffix ${keySuffix}:`, error);
      return null;
    }
  }

  /**
   * Get logo URL from Keybase profile
   */
  async getLogoUrl(username: string): Promise<string | null> {
    try {
      const profile = await this.getProfile(username);
      return profile?.avatar_url || null;
    } catch (error) {
      logger.error(`Failed to get logo URL for ${username}:`, error);
      return null;
    }
  }

  /**
   * Get logo URL from Keybase profile by key suffix
   */
  async getLogoUrlByKeySuffix(keySuffix: string): Promise<string | null> {
    try {
      const profile = await this.getProfileByKeySuffix(keySuffix);
      return profile?.avatar_url || null;
    } catch (error) {
      logger.error(`Failed to get logo URL for key suffix ${keySuffix}:`, error);
      return null;
    }
  }

  /**
   * Get multiple profiles in batch
   */
  async getProfilesBatch(usernames: string[]): Promise<Map<string, KeybaseProfile>> {
    const results = new Map<string, KeybaseProfile>();
    const uncachedUsernames: string[] = [];

    // Check cache first
    for (const username of usernames) {
      if (this.config.enableCaching) {
        const cached = this.cache.get(username);
        if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
          results.set(username, cached.data);
        } else {
          uncachedUsernames.push(username);
        }
      } else {
        uncachedUsernames.push(username);
      }
    }

    // Fetch uncached profiles
    if (uncachedUsernames.length > 0) {
      logger.info(`Fetching ${uncachedUsernames.length} Keybase profiles...`);
      
      // Process in batches to avoid rate limiting
      const batchSize = 5;
      for (let i = 0; i < uncachedUsernames.length; i += batchSize) {
        const batch = uncachedUsernames.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(async (username) => {
            try {
              const profile = await this.fetchProfileWithRetry(username);
              if (profile) {
                results.set(username, profile);
                
                if (this.config.enableCaching) {
                  this.cache.set(username, {
                    data: profile,
                    timestamp: Date.now()
                  });
                }
              }
            } catch (error) {
              logger.warn(`Failed to fetch profile for ${username}:`, error);
            }
          })
        );

        // Add delay between batches to be respectful to the API
        if (i + batchSize < uncachedUsernames.length) {
          await this.delay(2000);
        }
      }
    }

    return results;
  }

  /**
   * Validate if a Keybase username exists
   */
  async validateUsername(username: string): Promise<boolean> {
    try {
      const profile = await this.getProfile(username);
      return profile !== null;
    } catch (error) {
      logger.error(`Failed to validate Keybase username ${username}:`, error);
      return false;
    }
  }

  /**
   * Validate if a Keybase key suffix exists
   */
  async validateKeySuffix(keySuffix: string): Promise<boolean> {
    try {
      const profile = await this.getProfileByKeySuffix(keySuffix);
      return profile !== null;
    } catch (error) {
      logger.error(`Failed to validate Keybase key suffix ${keySuffix}:`, error);
      return false;
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('Keybase service cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalEntries: number;
    validEntries: number;
    expiredEntries: number;
    memoryUsage: number;
  } {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;

    for (const entry of this.cache.values()) {
      if (now - entry.timestamp < this.config.cacheTtl) {
        validEntries++;
      } else {
        expiredEntries++;
      }
    }

    return {
      totalEntries: this.cache.size,
      validEntries,
      expiredEntries,
      memoryUsage: this.cache.size * 1024 // Rough estimate
    };
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache(): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp >= this.config.cacheTtl) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} expired Keybase cache entries`);
    }

    return cleanedCount;
  }

  /**
   * Fetch profile with retry logic
   */
  private async fetchProfileWithRetry(username: string): Promise<KeybaseProfile | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response: AxiosResponse<KeybaseResponse> = await axios.get(
          `${this.config.baseUrl}/user/lookup.json`,
          {
            params: {
              username: username,
              fields: 'basics,profile,pictures'
            },
            timeout: this.config.timeout
          }
        );

        if (response.data.status.code === 0 && response.data.them && response.data.them.length > 0) {
          const apiProfile = response.data.them[0];
          return this.mapApiProfileToProfile(apiProfile);
        } else {
          logger.debug(`Keybase profile not found for ${username}: ${response.data.status.name}`);
          return null;
        }
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Attempt ${attempt}/${this.config.maxRetries} failed for ${username}:`, error);
        
        if (attempt < this.config.maxRetries) {
          await this.delay(this.config.retryDelay * attempt);
        }
      }
    }

    logger.error(`All retry attempts failed for ${username}:`, lastError);
    return null;
  }

  /**
   * Fetch profile by key suffix with retry logic
   */
  private async fetchProfileByKeySuffixWithRetry(keySuffix: string): Promise<KeybaseProfile | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response: AxiosResponse<KeybaseResponse> = await axios.get(
          `${this.config.baseUrl}/user/lookup.json`,
          {
            params: {
              key_suffix: keySuffix,
              fields: 'basics,profile,pictures'
            },
            timeout: this.config.timeout
          }
        );

        if (response.data.status.code === 0 && response.data.them && response.data.them.length > 0) {
          const apiProfile = response.data.them[0];
          return this.mapApiProfileToProfile(apiProfile);
        } else {
          logger.debug(`Keybase profile not found for key suffix ${keySuffix}: ${response.data.status.name}`);
          return null;
        }
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Attempt ${attempt}/${this.config.maxRetries} failed for key suffix ${keySuffix}:`, error);
        
        if (attempt < this.config.maxRetries) {
          await this.delay(this.config.retryDelay * attempt);
        }
      }
    }

    logger.error(`All retry attempts failed for key suffix ${keySuffix}:`, lastError);
    return null;
  }

  /**
   * Map API profile to internal profile format
   */
  private mapApiProfileToProfile(apiProfile: KeybaseApiProfile): KeybaseProfile {
    return {
      id: apiProfile.id,
      username: apiProfile.basics.username,
      full_name: apiProfile.profile?.full_name,
      avatar_url: apiProfile.pictures?.primary?.url,
      bio: apiProfile.profile?.bio,
      location: apiProfile.profile?.location,
      website: undefined, // Not available in current API response
      twitter: undefined, // Not available in current API response
      github: undefined, // Not available in current API response
      verified: apiProfile.basics.status === 0 // status 0 means verified
    };
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
} 