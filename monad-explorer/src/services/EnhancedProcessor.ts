import { EvmBatchProcessor } from '@subsquid/evm-processor';
import { Store } from '@subsquid/typeorm-store';
import { TokenEnrichmentWorker } from './TokenEnrichmentWorker';
import { Token, TokenTransfer, Log, Transaction, Block, TokenType } from '../model';
import { TokenService } from './TokenService';
import * as erc20 from '../abi/ERC20';
import * as erc721 from '../abi/ERC721';
import * as erc1155 from '../abi/ERC1155';
import { logger } from '../utils/logger';
import axios from 'axios';

export interface EnhancedProcessorConfig {
  enableTokenEnrichment: boolean;
  enableAsyncProcessing: boolean;
  enrichmentWorker?: TokenEnrichmentWorker;
  rpcUrl?: string;
}

/**
 * Enhanced processor that detects token transfers and performs metadata enrichment
 */
export class EnhancedProcessor {
  private readonly processor: EvmBatchProcessor;
  private readonly config: EnhancedProcessorConfig;
  private tokenEnrichmentWorker?: TokenEnrichmentWorker;
  private processedTokens = new Set<string>();
  private rpcClient: any;
  // Add reusable TokenService instance per batch
  private tokenService?: any;

  constructor(processor: EvmBatchProcessor, config: EnhancedProcessorConfig) {
    this.processor = processor;
    this.config = config;
    this.tokenEnrichmentWorker = config.enrichmentWorker;
    
    // Initialize RPC client for sync metadata enrichment
    if (config.rpcUrl) {
      this.rpcClient = this.createRpcClient(config.rpcUrl);
    }
  }

  /**
   * Process logs from Subsquid processor context and detect token transfers with enrichment
   */
  async processLogs(
    store: Store, 
    logs: Array<{ 
      address: string; 
      topics: string[]; 
      data: string; 
      transaction: { hash: string; block: { height: number; timestamp: number } };
      logIndex: number;
    }>,
    context?: {
      transactionMap?: Map<string, Transaction>;
      logMap?: Map<string, Log>;
    }
  ): Promise<{ transfers: TokenTransfer[], tokens: Token[] }> {
    const tokenTransfers: TokenTransfer[] = [];
    const enrichedTokens: Token[] = [];
    const enrichmentJobs: Array<{
      tokenAddress: string;
      blockNumber: number;
      transactionHash: string;
    }> = [];

    // Batch-level token cache to avoid duplicate RPC calls
    const batchTokenCache = new Map<string, Token>();
    
    // Pre-load existing tokens from database to avoid unnecessary RPC calls
    const uniqueTokenAddresses = [...new Set(logs.map(log => log.address))];
    const existingTokensMap = await this.preloadExistingTokens(store, uniqueTokenAddresses);

    // Initialize reusable TokenService for this batch
    if (this.config.enableTokenEnrichment && this.rpcClient && logs.length > 0) {
      const avgBlockHeight = Math.floor(
        logs.reduce((sum, log) => sum + log.transaction.block.height, 0) / logs.length
      );
      this.tokenService = TokenService.createStandalone(this.rpcClient, avgBlockHeight);
    }

    for (const logItem of logs) {
      try {
        const result = await this.processTokenTransferWithEnrichment(
          store, 
          logItem, 
          context,
          batchTokenCache,
          existingTokensMap
        );
        
        if (result?.transfer) {
          tokenTransfers.push(result.transfer);
          
          if (result.token && !enrichedTokens.find(t => t.id === result.token!.id)) {
            enrichedTokens.push(result.token);
          }
        }
      } catch (error) {
        logger.debug('Failed to process log as token transfer', {
          address: logItem.address,
          transactionHash: logItem.transaction.hash,
          logIndex: logItem.logIndex,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Queue async enrichment jobs if worker is available
    if (this.config.enableAsyncProcessing && this.config.enrichmentWorker && enrichmentJobs.length > 0) {
      try {
        // Note: TokenEnrichmentWorker method name might be different
        // await this.config.enrichmentWorker.queueEnrichmentJobs(enrichmentJobs);
        logger.debug('Async enrichment jobs would be queued here', { jobCount: enrichmentJobs.length });
      } catch (error) {
        logger.warn('Failed to queue async enrichment jobs', { error });
      }
    }

    logger.info('Processed enhanced token transfers', {
      transferCount: tokenTransfers.length,
      enrichedTokenCount: enrichedTokens.length,
      queuedJobs: enrichmentJobs.length,
      batchCacheSize: batchTokenCache.size,
      processedTokensSize: this.processedTokens.size
    });

    // Clean up batch-specific data
    this.tokenService = undefined;
    this.clearProcessedTokensCache();

    return { transfers: tokenTransfers, tokens: enrichedTokens };
  }

  /**
   * Pre-load existing tokens from database to avoid unnecessary RPC calls
   */
  private async preloadExistingTokens(
    store: Store, 
    tokenAddresses: string[]
  ): Promise<Map<string, Token>> {
    const existingTokensMap = new Map<string, Token>();
    
    if (tokenAddresses.length === 0) {
      return existingTokensMap;
    }

    try {
      // Batch load existing tokens from database using In operator
      const { In } = await import('typeorm');
      const existingTokens = await store.find(Token, {
        where: { address: In(tokenAddresses) }
      });

      // Map by address for O(1) lookup
      existingTokens.forEach(token => {
        existingTokensMap.set(token.address, token);
      });

      logger.info('Pre-loaded existing tokens from database', {
        requestedCount: tokenAddresses.length,
        foundCount: existingTokens.length,
        cacheHitRate: `${((existingTokens.length / tokenAddresses.length) * 100).toFixed(1)}%`
      });
    } catch (error) {
      logger.warn('Failed to pre-load existing tokens', { error });
    }

    return existingTokensMap;
  }

  /**
   * Process a single token transfer with optional metadata enrichment
   */
  private async processTokenTransferWithEnrichment(
    store: Store,
    logItem: { 
      address: string; 
      topics: string[]; 
      data: string; 
      transaction: { hash: string; block: { height: number; timestamp: number } };
      logIndex: number;
    },
    context: {
      transactionMap?: Map<string, Transaction>;
      logMap?: Map<string, Log>;
    } | undefined,
    batchTokenCache: Map<string, Token>,
    existingTokensMap: Map<string, Token>
  ): Promise<{ transfer: TokenTransfer, token?: Token } | null> {
    const logRecord = { topics: logItem.topics, data: logItem.data };

    // Pre-validation: Check for invalid hex values
    for (const topic of logItem.topics) {
      if (this.isInvalidHexValue(topic)) {
        logger.debug('Invalid hex value in topics, skipping', {
          address: logItem.address,
          topic,
          transactionHash: logItem.transaction.hash
        });
        return null;
      }
    }

    if (this.isInvalidHexValue(logItem.data)) {
      logger.debug('Invalid hex value in data, skipping', {
        address: logItem.address,
        data: logItem.data,
        transactionHash: logItem.transaction.hash
      });
      return null;
    }

    // Get transaction and log entities - prefer from context map if available
    let transaction: Transaction | undefined;
    let log: Log | undefined;

    if (context?.transactionMap && context?.logMap) {
      // Use context maps for O(1) lookup
      transaction = context.transactionMap.get(logItem.transaction.hash);
      log = context.logMap.get(`${logItem.transaction.hash}-${logItem.logIndex}`);
    } else {
      // Fallback to store lookup (slower)
      transaction = await store.get(Transaction, logItem.transaction.hash);
      log = await store.get(Log, `${logItem.transaction.hash}-${logItem.logIndex}`);
    }

    if (!transaction) {
      logger.debug('Transaction not found, skipping transfer processing', {
        hash: logItem.transaction.hash
      });
      return null;
    }

    if (!log) {
      logger.debug('Log not found, skipping transfer processing', {
        logId: `${logItem.transaction.hash}-${logItem.logIndex}`
      });
      return null;
    }

    // Enhanced token transfer detection with proper ERC standard discrimination
    const transfer = await this.detectAndDecodeTransfer(logRecord, logItem, transaction, log);
    if (!transfer.tokenTransfer || !transfer.detectedType) {
      return null;
    }

    // Get or create enriched token
    const enrichedToken = await this.getOrCreateEnrichedToken(
      store, 
      logItem.address, 
      transfer.detectedType, 
      logItem.transaction.block.height,
      new Date(logItem.transaction.block.timestamp * 1000),
      batchTokenCache,
      existingTokensMap
    );

    // Assign token to transfer
    transfer.tokenTransfer.token = enrichedToken;

    return { transfer: transfer.tokenTransfer, token: enrichedToken };
  }

  /**
   * Detect and decode token transfer events with proper ERC standard discrimination
   */
  private async detectAndDecodeTransfer(
    logRecord: { topics: string[], data: string },
    logItem: any,
    transaction: Transaction,
    log: Log
  ): Promise<{ tokenTransfer: TokenTransfer | null, detectedType: TokenType | null }> {
    const { topics, data } = logRecord;

    let transfer: TokenTransfer | null = null;
    let detectedTokenType: TokenType | null = null;

    try {
      // Check for ERC20/ERC721 Transfer event signature
      if (topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
        // ERC20 Transfer: 3 topics (signature, from, to) + data contains value
        if (topics.length === 3 && data && data !== "0x" && data.length >= 66) {
          // Try ERC20 Transfer decode
          if (erc20.events.Transfer.is(logRecord)) {
            const transferData = erc20.events.Transfer.decode(logRecord);
            detectedTokenType = TokenType.ERC20;
            
            transfer = new TokenTransfer({
              id: `${logItem.transaction.hash}-${logItem.logIndex}`,
              fromAddress: transferData.from,
              toAddress: transferData.to,
              value: transferData.value,
              tokenId: null,
              timestamp: new Date(logItem.transaction.block.timestamp * 1000),
              transaction,
              log
            });

            logger.debug('Detected ERC20 Transfer', {
              address: logItem.address,
              from: transferData.from,
              to: transferData.to,
              value: transferData.value.toString()
            });
          }
        }
        // ERC721 Transfer: 4 topics (signature, from, to, tokenId) + usually empty data
        else if (topics.length === 4) {
          // Try ERC721 Transfer decode
          if (erc721.events.Transfer.is(logRecord)) {
            const transferData = erc721.events.Transfer.decode(logRecord);
            detectedTokenType = TokenType.ERC721;
            
            transfer = new TokenTransfer({
              id: `${logItem.transaction.hash}-${logItem.logIndex}`,
              fromAddress: transferData.from,
              toAddress: transferData.to,
              value: 1n, // NFTs are always 1
              tokenId: transferData.tokenId,
              timestamp: new Date(logItem.transaction.block.timestamp * 1000),
              transaction,
              log
            });

            logger.debug('Detected ERC721 Transfer', {
              address: logItem.address,
              from: transferData.from,
              to: transferData.to,
              tokenId: transferData.tokenId.toString()
            });
          }
        }
      }
      // ERC1155 TransferSingle: Different signature
      else if (topics[0] === '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62') {
        if (erc1155.events.TransferSingle.is(logRecord)) {
          const transferData = erc1155.events.TransferSingle.decode(logRecord);
          detectedTokenType = TokenType.ERC1155;
          
          transfer = new TokenTransfer({
            id: `${logItem.transaction.hash}-${logItem.logIndex}`,
            fromAddress: transferData.from,
            toAddress: transferData.to,
            value: transferData.value,
            tokenId: transferData.id,
            timestamp: new Date(logItem.transaction.block.timestamp * 1000),
            transaction,
            log
          });

          logger.debug('Detected ERC1155 TransferSingle', {
            address: logItem.address,
            from: transferData.from,
            to: transferData.to,
            tokenId: transferData.id.toString(),
            value: transferData.value.toString()
          });
        }
      }
    } catch (error) {
      logger.debug('Failed to decode transfer event', {
        address: logItem.address,
        topicsLength: topics.length,
        dataLength: data.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return { tokenTransfer: null, detectedType: null };
    }

    return { tokenTransfer: transfer, detectedType: detectedTokenType };
  }

  /**
   * Check if hex value is invalid (negative, malformed, etc.)
   */
  private isInvalidHexValue(value: string): boolean {
    if (!value || typeof value !== 'string') {
      return true;
    }

    // Check for negative hex values
    if (value.includes('-')) {
      return true;
    }

    // Check for proper hex format
    if (!value.startsWith('0x')) {
      return true;
    }

    // Check for valid hex characters
    const hexPattern = /^0x[0-9a-fA-F]*$/;
    if (!hexPattern.test(value)) {
      return true;
    }

    return false;
  }

  /**
   * Get existing token or create new one with metadata enrichment
   */
  private async getOrCreateEnrichedToken(
    store: Store,
    tokenAddress: string,
    detectedType: TokenType,
    blockNumber: number,
    timestamp: Date,
    batchTokenCache: Map<string, Token>,
    existingTokensMap: Map<string, Token>
  ): Promise<Token> {
    // Check if token already exists in batch cache
    let existingToken = batchTokenCache.get(tokenAddress);
    if (existingToken) {
      logger.debug('Token found in batch cache', { address: tokenAddress });
      // Update token type if it was previously unknown
      if (existingToken.tokenType !== detectedType) {
        existingToken.tokenType = detectedType;
        await store.save(existingToken);
        logger.debug('Updated existing token type', {
          address: tokenAddress,
          oldType: existingToken.tokenType,
          newType: detectedType
        });
      }
      return existingToken;
    }

    // Check if token already exists in existing tokens map (DB preload)
    existingToken = existingTokensMap.get(tokenAddress);
    if (existingToken) {
      logger.debug('Token found in DB preload cache', { address: tokenAddress });
      // Add to batch cache for future lookups in this batch
      batchTokenCache.set(tokenAddress, existingToken);
      
      // Update token type if it was previously unknown
      if (existingToken.tokenType !== detectedType) {
        existingToken.tokenType = detectedType;
        await store.save(existingToken);
        logger.debug('Updated existing token type', {
          address: tokenAddress,
          oldType: existingToken.tokenType,
          newType: detectedType
        });
      }
      return existingToken;
    }

    // ⚡ CRITICAL: Check if we're already processing this token in current batch
    // This prevents multiple RPC calls for the same token within single batch
    if (this.processedTokens.has(tokenAddress)) {
      logger.debug('Token already being processed in this batch, creating fallback', { 
        address: tokenAddress 
      });
      
      const fallbackToken = new Token({
        id: tokenAddress,
        address: tokenAddress,
        name: this.generateFallbackName(detectedType, tokenAddress),
        symbol: 'UNKNOWN',
        decimals: this.getDefaultDecimals(detectedType),
        totalSupply: null,
        tokenType: detectedType,
        createdAt: timestamp
      });
      
      // Add to batch cache
      batchTokenCache.set(tokenAddress, fallbackToken);
      return fallbackToken;
    }

    // Mark token as being processed
    this.processedTokens.add(tokenAddress);

    // Create new token with metadata enrichment if sync enrichment is enabled
    if (this.config.enableTokenEnrichment && this.tokenService) {
      try {
        const metadata = await this.tokenService.fetchTokenMetadata(tokenAddress);
        
        if (metadata) {
          const enrichedToken = new Token({
            id: tokenAddress,
            address: tokenAddress,
            name: metadata.name,
            symbol: metadata.symbol,
            decimals: metadata.decimals || null,
            totalSupply: metadata.totalSupply || null,
            tokenType: metadata.tokenType,
            createdAt: timestamp
          });

          // ⚡ CRITICAL: Add to batch cache to prevent duplicate processing
          batchTokenCache.set(tokenAddress, enrichedToken);

          logger.info('Created enriched token with real metadata', {
            address: tokenAddress,
            name: metadata.name,
            symbol: metadata.symbol,
            type: metadata.tokenType
          });

          return enrichedToken;
        }
      } catch (error) {
        logger.warn('Sync token enrichment failed, using fallback', {
          address: tokenAddress,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Fallback: Create token with basic metadata
    const fallbackToken = new Token({
      id: tokenAddress,
      address: tokenAddress,
      name: this.generateFallbackName(detectedType, tokenAddress),
      symbol: 'UNKNOWN',
      decimals: this.getDefaultDecimals(detectedType),
      totalSupply: null,
      tokenType: detectedType,
      createdAt: timestamp
    });

    // ⚡ CRITICAL: Add to batch cache to prevent duplicate processing
    batchTokenCache.set(tokenAddress, fallbackToken);

    logger.debug('Created token with fallback metadata', {
      address: tokenAddress,
      type: detectedType,
      name: fallbackToken.name
    });

    return fallbackToken;
  }

  /**
   * Generate fallback name based on token type
   */
  private generateFallbackName(tokenType: TokenType, address: string): string {
    const shortAddress = address.slice(0, 8) + '...';
    switch (tokenType) {
      case TokenType.ERC20:
        return `Token ${shortAddress}`;
      case TokenType.ERC721:
        return `NFT ${shortAddress}`;
      case TokenType.ERC1155:
        return `Multi-Token ${shortAddress}`;
      default:
        return `Token ${shortAddress}`;
    }
  }

  /**
   * Get default decimals based on token type
   */
  private getDefaultDecimals(tokenType: TokenType): number | null {
    switch (tokenType) {
      case TokenType.ERC20:
        return 18; // Standard ERC20 decimals
      case TokenType.ERC721:
      case TokenType.ERC1155:
        return 0; // NFTs don't have decimals
      default:
        return null;
    }
  }

  /**
   * Create RPC client for blockchain calls
   */
  private createRpcClient(rpcUrl: string) {
    return {
      async call<T = any>(method: string, params?: unknown[]): Promise<T> {
        const response = await axios.post(rpcUrl, {
          jsonrpc: '2.0',
          method,
          params: params || [],
          id: Date.now()
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (response.data.error) {
          throw new Error(`RPC Error: ${response.data.error.message}`);
        }

        return response.data.result;
      }
    };
  }

  /**
   * Determines if a token should be enriched
   */
  private shouldEnrichToken(tokenAddress: string): boolean {
    // Avoid duplicate enrichment jobs for the same token in a single batch
    if (this.processedTokens.has(tokenAddress)) {
      return false;
    }

    this.processedTokens.add(tokenAddress);
    return true;
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return {
      processedTokensCount: this.processedTokens.size,
      enrichmentEnabled: this.config.enableTokenEnrichment,
      asyncProcessingEnabled: this.config.enableAsyncProcessing,
      workerStatus: this.tokenEnrichmentWorker?.getStatus()
    };
  }

  /**
   * Clear processed tokens cache (call this at the start of each batch)
   */
  clearProcessedTokensCache(): void {
    this.processedTokens.clear();
  }
} 