import { ITokenDetectionService, TokenDetectionResult, TokenDetectionOptions } from '../../interfaces/services/ITokenDetectionService';
import { IEventTokenDetector, LogEvent, TokenDetectionFromEvent } from '../../interfaces/services/IEventTokenDetector';
import { ITokenRepository, TokenInfo } from '../../interfaces/services/ITokenRepository';
import { ITokenMetadataFetcher, TokenMetadata } from '../../interfaces/services/ITokenMetadataFetcher';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { TokenType } from '../../model';
import { logger } from '../../utils/logger';

export interface TokenDetectionStats {
  totalDetections: number;
  successfulDetections: number;
  erc20Count: number;
  erc721Count: number;
  erc1155Count: number;
  unknownCount: number;
  averageConfidence: number;
  cacheHitRate: number;
  errorCount: number;
}

/**
 * Event-based token detection service
 * Uses SOLID principles: dependency injection, single responsibility
 * No unnecessary RPC calls - detects from events, fetches metadata only when needed
 */
export class TokenDetectionService implements ITokenDetectionService {
  private readonly stats: TokenDetectionStats = {
    totalDetections: 0,
    successfulDetections: 0,
    erc20Count: 0,
    erc721Count: 0,
    erc1155Count: 0,
    unknownCount: 0,
    averageConfidence: 0,
    cacheHitRate: 0,
    errorCount: 0,
  };

  constructor(
    private readonly eventDetector: IEventTokenDetector,
    private readonly tokenRepository: ITokenRepository,
    private readonly metadataFetcher: ITokenMetadataFetcher,
    private readonly cacheService: ICacheService
  ) {}

  /**
   * Main detection method - uses event-based approach + database cache
   */
  public async detectTokenType(
    tokenAddress: string,
    options: TokenDetectionOptions = {}
  ): Promise<TokenDetectionResult> {
    const startTime = Date.now();
    this.stats.totalDetections++;

    try {
      // 1. Check database first (persistent cache)
      const existingToken = await this.tokenRepository.get(tokenAddress);
      if (existingToken) {
        this.updateCacheHitRate(true);
        /* logger.debug('Token type served from database', { 
          tokenAddress, 
          type: existingToken.type 
        }); */
        return this.createResultFromTokenInfo(existingToken);
      }

      this.updateCacheHitRate(false);

      // 2. If we have a transfer event log, use event-based detection
      if (options.transferLog) {
        const result = await this.detectFromTransferEvent(tokenAddress, options.transferLog, options.blockNumber);
        this.updateStats(result, Date.now() - startTime);
        return result;
      }

      // 3. Fallback: no event data, return unknown (avoid RPC calls)
      logger.debug('No transfer event provided, cannot detect token type', { tokenAddress });
      return this.createEmptyResult();

    } catch (error) {
      this.stats.errorCount++;
      logger.error('Token detection failed', {
        tokenAddress,
        blockNumber: options.blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      });

      return this.createEmptyResult();
    }
  }

  /**
   * Detect token type from transfer event (main detection method)
   */
  public async detectFromTransferEvent(
    tokenAddress: string, 
    transferLog: LogEvent, 
    blockNumber?: number
  ): Promise<TokenDetectionResult> {
    try {
      // 1. Event-based detection (no RPC calls)
      const eventDetection = this.eventDetector.detectFromTransferEvent(transferLog);
      
      if (!eventDetection) {
        logger.debug('Not a transfer event', { tokenAddress, topics: transferLog.topics });
        return this.createEmptyResult();
      }

      // 2. Fetch metadata only if needed (minimal RPC calls)
      const metadata = await this.metadataFetcher.fetchMetadata(
        tokenAddress, 
        eventDetection.tokenType, 
        blockNumber
      );

      if (!metadata.contractExists) {
        logger.debug('Contract does not exist', { tokenAddress });
        return this.createEmptyResult();
      }

      // 3. Create result
      const result = this.createResultFromDetection(eventDetection, metadata);

      // 4. Save to database for future use
      await this.saveTokenToDatabase(tokenAddress, eventDetection.tokenType, metadata);

      logger.info('Token detected via event analysis', {
        tokenAddress,
        type: eventDetection.tokenType,
        confidence: result.confidence,
        method: eventDetection.detectionMethod,
      });

      return result;

    } catch (error) {
      logger.error('Event-based detection failed', {
        tokenAddress,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return this.createEmptyResult();
    }
  }

  /**
   * Check if contract exists (delegates to metadata fetcher)
   */
  public async contractExists(tokenAddress: string, blockNumber?: number): Promise<boolean> {
    return this.metadataFetcher.contractExists(tokenAddress, blockNumber);
  }

  public getStats(): TokenDetectionStats {
    return { ...this.stats };
  }

  // ========== Helper Methods ==========

  private createResultFromTokenInfo(tokenInfo: TokenInfo): TokenDetectionResult {
    return {
      isERC20: tokenInfo.type === TokenType.ERC20,
      isERC721: tokenInfo.type === TokenType.ERC721,
      isERC1155: tokenInfo.type === TokenType.ERC1155,
      supportedInterfaces: [tokenInfo.type],
      detectedType: tokenInfo.type,
      confidence: 0.99, // High confidence from database
    };
  }

  private createResultFromDetection(
    eventDetection: TokenDetectionFromEvent, 
    metadata: TokenMetadata
  ): TokenDetectionResult {
    return {
      isERC20: eventDetection.tokenType === TokenType.ERC20,
      isERC721: eventDetection.tokenType === TokenType.ERC721,
      isERC1155: eventDetection.tokenType === TokenType.ERC1155,
      supportedInterfaces: [eventDetection.tokenType],
      detectedType: eventDetection.tokenType,
      confidence: eventDetection.confidence,
    };
  }

  private async saveTokenToDatabase(
    address: string, 
    tokenType: TokenType, 
    metadata: TokenMetadata
  ): Promise<void> {
    try {
      const tokenInfo: TokenInfo = {
        address,
        type: tokenType,
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        totalSupply: metadata.totalSupply,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await this.tokenRepository.save(tokenInfo);
      
      logger.debug('Token saved to database', { 
        address, 
        type: tokenType, 
        name: metadata.name, 
        symbol: metadata.symbol 
      });
    } catch (error) {
      logger.warn('Failed to save token to database', {
        address,
        tokenType,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private createEmptyResult(): TokenDetectionResult {
    return {
      isERC20: false,
      isERC721: false,
      isERC1155: false,
      supportedInterfaces: [],
      detectedType: null,
      confidence: 0,
    };
  }

  private updateStats(result: TokenDetectionResult, duration: number): void {
    if (result.detectedType) {
      this.stats.successfulDetections++;
      
      switch (result.detectedType) {
        case TokenType.ERC20:
          this.stats.erc20Count++;
          break;
        case TokenType.ERC721:
          this.stats.erc721Count++;
          break;
        case TokenType.ERC1155:
          this.stats.erc1155Count++;
          break;
      }
    } else {
      this.stats.unknownCount++;
    }

    // Update average confidence
    const totalSuccessful = this.stats.successfulDetections;
    if (totalSuccessful > 0) {
      this.stats.averageConfidence = 
        (this.stats.averageConfidence * (totalSuccessful - 1) + result.confidence) / totalSuccessful;
    }
  }

  private updateCacheHitRate(isHit: boolean): void {
    const totalDetections = this.stats.totalDetections;
    const currentHits = this.stats.cacheHitRate * (totalDetections - 1);
    const newHits = currentHits + (isHit ? 1 : 0);
    this.stats.cacheHitRate = newHits / totalDetections;
  }
} 