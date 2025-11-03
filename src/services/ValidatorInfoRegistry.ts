/**
 * Validator Info Registry Service
 *
 * Fetches validator information from the GitHub registry at:
 * https://github.com/monad-developers/validator-info
 *
 * Validators self-register their information by creating JSON files named
 * after their SECP key (node_id). This service:
 * 1. Fetches the list of validators from GitHub API
 * 2. Batch downloads and caches validator JSON files
 * 3. Provides validator lookup by node_id
 * 4. Falls back to hostname extraction for validators not in registry
 * 5. Periodically refreshes the cache (every 1 hour)
 */

import { DomainExtractor } from './dns/DomainExtractor.js';

export interface ValidatorInfo {
  id: number;
  name: string;
  secp: string;
  bls: string;
  website: string;
  description: string;
  logo: string;
  x: string;
}

interface GitHubContentItem {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: string;
}

export type ValidatorNetwork = 'testnet' | 'mainnet';

export interface ValidatorInfoRegistryConfig {
  network?: ValidatorNetwork;
  githubToken?: string;
}

export class ValidatorInfoRegistry {
  private static readonly GITHUB_API_BASE = 'https://api.github.com';
  private static readonly GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
  private static readonly REPO_OWNER = 'monad-developers';
  private static readonly REPO_NAME = 'validator-info';
  private static readonly BRANCH = 'main';

  private static readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  private static readonly BATCH_SIZE = 20; // Process 20 validators at a time
  private static readonly BATCH_DELAY_MS = 1000; // 1 second between batches

  private validatorCache: Map<string, ValidatorInfo> = new Map();
  private lastFetchTime: number = 0;
  private isFetching: boolean = false;
  private domainExtractor: DomainExtractor;
  private refreshTimer?: NodeJS.Timeout;
  private network: ValidatorNetwork;
  private githubToken?: string;

  constructor(config?: ValidatorInfoRegistryConfig) {
    this.domainExtractor = new DomainExtractor();
    this.network = config?.network || 'testnet';
    this.githubToken = config?.githubToken || process.env.GITHUB_TOKEN;

    if (!this.githubToken) {
      console.warn('[ValidatorInfoRegistry] No GitHub token provided. Rate limits will be restrictive (60 requests/hour).');
      console.warn('[ValidatorInfoRegistry] Set GITHUB_TOKEN environment variable to increase limit to 5000 requests/hour.');
    }

    this.startPeriodicRefresh();
  }

  /**
   * Get validator info by node_id (SECP public key)
   * Returns null if not found in registry (caller should fall back to hostname extraction)
   */
  async getValidatorInfo(nodeId: string, _hostname?: string): Promise<ValidatorInfo | null> {
    // Ensure cache is fresh
    await this.ensureCacheLoaded();

    // Normalize node_id: remove 0x prefix if present
    const normalizedId = nodeId.toLowerCase().replace('0x', '');

    // Lookup in cache
    const info = this.validatorCache.get(normalizedId);

    if (info) {
      return info;
    }

    // Not found in registry - caller should fall back to hostname extraction
    return null;
  }

  /**
   * Get validator name with automatic fallback to hostname extraction
   */
  async getValidatorName(nodeId: string, hostname?: string): Promise<string> {
    const info = await this.getValidatorInfo(nodeId, hostname);

    if (info) {
      return info.name;
    }

    // Fallback to hostname extraction
    if (hostname) {
      return this.domainExtractor.extractValidatorName(hostname);
    }

    return 'unknown';
  }

  /**
   * Ensure the cache is loaded and fresh
   */
  private async ensureCacheLoaded(): Promise<void> {
    const now = Date.now();
    const isCacheExpired = (now - this.lastFetchTime) > ValidatorInfoRegistry.CACHE_TTL_MS;
    const isCacheEmpty = this.validatorCache.size === 0;

    if ((isCacheExpired || isCacheEmpty) && !this.isFetching) {
      await this.refreshCache();
    }
  }

  /**
   * Refresh the validator cache from GitHub
   */
  async refreshCache(): Promise<void> {
    if (this.isFetching) {
      console.log('[ValidatorInfoRegistry] Cache refresh already in progress, skipping');
      return;
    }

    this.isFetching = true;
    const startTime = Date.now();

    try {
      console.log(`[ValidatorInfoRegistry] Refreshing validator info cache from GitHub (${this.network})...`);

      // Step 1: Get list of JSON files in the network directory
      const files = await this.fetchNetworkDirectory();
      console.log(`[ValidatorInfoRegistry] Found ${files.length} validator files in ${this.network} registry`);

      // Step 2: Batch download and parse JSON files
      const validatorInfos = await this.batchFetchValidatorFiles(files);

      // Step 3: Update cache
      this.validatorCache.clear();
      for (const info of validatorInfos) {
        // Key by SECP key (without 0x prefix, lowercase)
        const key = info.secp.toLowerCase().replace('0x', '');
        this.validatorCache.set(key, info);
      }

      this.lastFetchTime = Date.now();
      const duration = Date.now() - startTime;

      console.log(`[ValidatorInfoRegistry] Cache refreshed successfully in ${duration}ms`);
      console.log(`[ValidatorInfoRegistry] Cached ${this.validatorCache.size} validators`);
    } catch (error) {
      console.error('[ValidatorInfoRegistry] Failed to refresh cache:', error);
      // Keep existing cache on error
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Fetch the list of validator JSON files from GitHub for the configured network
   */
  private async fetchNetworkDirectory(): Promise<GitHubContentItem[]> {
    const url = `${ValidatorInfoRegistry.GITHUB_API_BASE}/repos/${ValidatorInfoRegistry.REPO_OWNER}/${ValidatorInfoRegistry.REPO_NAME}/contents/${this.network}`;

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'monad-validator-service'
    };

    // Add GitHub token if available
    if (this.githubToken) {
      headers['Authorization'] = `Bearer ${this.githubToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error body');
      throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const items = await response.json() as GitHubContentItem[];

    // Filter only JSON files
    return items.filter(item => item.type === 'file' && item.name.endsWith('.json'));
  }

  /**
   * Batch fetch validator JSON files from GitHub
   */
  private async batchFetchValidatorFiles(files: GitHubContentItem[]): Promise<ValidatorInfo[]> {
    const validatorInfos: ValidatorInfo[] = [];
    const totalFiles = files.length;
    let processedCount = 0;

    // Process in batches to avoid rate limiting
    for (let i = 0; i < files.length; i += ValidatorInfoRegistry.BATCH_SIZE) {
      const batch = files.slice(i, i + ValidatorInfoRegistry.BATCH_SIZE);

      // Fetch batch in parallel
      const batchPromises = batch.map(file => this.fetchValidatorFile(file));
      const batchResults = await Promise.allSettled(batchPromises);

      // Collect successful results
      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          validatorInfos.push(result.value);
        } else if (result.status === 'rejected') {
          console.warn(`[ValidatorInfoRegistry] Failed to fetch validator file:`, result.reason);
        }
      }

      processedCount += batch.length;
      console.log(`[ValidatorInfoRegistry] Processed ${processedCount}/${totalFiles} validators`);

      // Delay between batches (except for last batch)
      if (i + ValidatorInfoRegistry.BATCH_SIZE < files.length) {
        await this.delay(ValidatorInfoRegistry.BATCH_DELAY_MS);
      }
    }

    return validatorInfos;
  }

  /**
   * Fetch and parse a single validator JSON file
   */
  private async fetchValidatorFile(file: GitHubContentItem): Promise<ValidatorInfo | null> {
    try {
      // Use raw.githubusercontent.com for direct file access
      const url = `${ValidatorInfoRegistry.GITHUB_RAW_BASE}/${ValidatorInfoRegistry.REPO_OWNER}/${ValidatorInfoRegistry.REPO_NAME}/${ValidatorInfoRegistry.BRANCH}/${this.network}/${file.name}`;

      const headers: Record<string, string> = {
        'User-Agent': 'monad-validator-service'
      };

      // Add GitHub token if available (also works for raw.githubusercontent.com)
      if (this.githubToken) {
        headers['Authorization'] = `Bearer ${this.githubToken}`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        console.warn(`[ValidatorInfoRegistry] Failed to fetch ${file.name}: ${response.status}`);
        return null;
      }

      const validatorInfo = await response.json() as ValidatorInfo;

      // Validate required fields
      if (!validatorInfo.name || !validatorInfo.secp) {
        console.warn(`[ValidatorInfoRegistry] Invalid validator info in ${file.name}: missing required fields`);
        return null;
      }

      return validatorInfo;
    } catch (error) {
      console.warn(`[ValidatorInfoRegistry] Error parsing ${file.name}:`, error);
      return null;
    }
  }

  /**
   * Start periodic cache refresh
   */
  private startPeriodicRefresh(): void {
    // Refresh every hour
    this.refreshTimer = setInterval(() => {
      this.refreshCache().catch(error => {
        console.error('[ValidatorInfoRegistry] Periodic refresh failed:', error);
      });
    }, ValidatorInfoRegistry.CACHE_TTL_MS);

    // Ensure the timer doesn't prevent process exit
    if (this.refreshTimer.unref) {
      this.refreshTimer.unref();
    }
  }

  /**
   * Stop periodic refresh (for cleanup)
   */
  stopPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /**
   * Utility: delay for specified milliseconds
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; lastFetchTime: number; isFetching: boolean } {
    return {
      size: this.validatorCache.size,
      lastFetchTime: this.lastFetchTime,
      isFetching: this.isFetching
    };
  }

  /**
   * Force cache refresh (useful for testing)
   */
  async forceRefresh(): Promise<void> {
    this.lastFetchTime = 0; // Expire cache
    await this.refreshCache();
  }
}
