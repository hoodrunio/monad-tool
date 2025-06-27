import { ITokenDetectionService, TokenDetectionResult, TokenDetectionOptions } from '../../interfaces/services/ITokenDetectionService';
import { IRpcClient } from '../../interfaces/blockchain/IRpcClient';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { TokenType } from '../../model';
import * as erc20 from '../../abi/ERC20';
import * as erc721 from '../../abi/ERC721';
import * as erc1155 from '../../abi/ERC1155';
import * as erc165 from '../../abi/ERC165';
import { ChainContext, Block } from '../../abi/abi.support';
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

export class TokenDetectionService implements ITokenDetectionService {
  // Standard ERC interface IDs (EIP-165)
  private static readonly ERC165_INTERFACE_ID = '0x01ffc9a7';
  private static readonly ERC20_INTERFACE_ID = '0x36372b07';
  private static readonly ERC721_INTERFACE_ID = '0x80ac58cd';
  private static readonly ERC1155_INTERFACE_ID = '0xd9b67a26';

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
    private readonly rpcClient: IRpcClient,
    private readonly cacheService: ICacheService
  ) {}

  public async detectTokenType(
    tokenAddress: string,
    options: TokenDetectionOptions = {}
  ): Promise<TokenDetectionResult> {
    const startTime = Date.now();
    this.stats.totalDetections++;

    try {
      // Check cache first
      const cacheKey = `token_detection:${tokenAddress}:${options.blockNumber || 'latest'}`;
      const cached = await this.cacheService.get<TokenDetectionResult>(cacheKey);
      
      if (cached) {
        this.updateCacheHitRate(true);
        logger.debug('Token detection served from cache', { tokenAddress, blockNumber: options.blockNumber });
        return cached;
      }

      this.updateCacheHitRate(false);

      // Perform detection
      const result = await this.performDetection(tokenAddress, options);
      
      // Cache the result
      const cacheTtl = 300000; // 5 minutes
      await this.cacheService.set(cacheKey, result, cacheTtl);

      // Update statistics
      this.updateStats(result, Date.now() - startTime);

      logger.info('Token type detection completed', {
        tokenAddress,
        detectedType: result.detectedType,
        confidence: result.confidence,
        supportedInterfaces: result.supportedInterfaces,
        blockNumber: options.blockNumber,
        duration: Date.now() - startTime,
      });

      return result;

    } catch (error) {
      this.stats.errorCount++;
      logger.error('Token detection failed', {
        tokenAddress,
        blockNumber: options.blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      });

      // Return default result on error
      return {
        isERC20: false,
        isERC721: false,
        isERC1155: false,
        supportedInterfaces: [],
        detectedType: null,
        confidence: 0,
      };
    }
  }

  public async contractExists(tokenAddress: string, blockNumber?: number): Promise<boolean> {
    try {
      const code = await this.rpcClient.getCode(tokenAddress, blockNumber || 'latest');
      const exists = Boolean(code && code !== '0x' && code.length > 2);
      
      logger.debug('Contract existence check', {
        address: tokenAddress,
        blockNumber,
        exists,
        codeLength: typeof code === 'string' ? code.length : 0,
      });

      return exists;
    } catch (error) {
      logger.debug('Contract existence check failed', {
        address: tokenAddress,
        blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  public async supportsERC165(tokenAddress: string): Promise<boolean> {
    try {
      const context = this.createChainContext();
      const block = this.createBlock();
      const erc165Contract = new erc165.Contract(context, block, tokenAddress);
      
      const supports = await this.safeCall(() => 
        erc165Contract.supportsInterface(TokenDetectionService.ERC165_INTERFACE_ID)
      );
      
      return supports || false;
    } catch {
      return false;
    }
  }

  public async supportsInterface(tokenAddress: string, interfaceId: string): Promise<boolean> {
    try {
      const context = this.createChainContext();
      const block = this.createBlock();
      const erc165Contract = new erc165.Contract(context, block, tokenAddress);
      
      const supports = await this.safeCall(() => 
        erc165Contract.supportsInterface(interfaceId)
      );
      
      return supports || false;
    } catch {
      return false;
    }
  }

  public getStats(): TokenDetectionStats {
    return { ...this.stats };
  }

  private async performDetection(
    tokenAddress: string,
    options: TokenDetectionOptions
  ): Promise<TokenDetectionResult> {
    // Check if contract exists first
    const contractExists = await this.contractExists(tokenAddress, options.blockNumber);
    if (!contractExists) {
      logger.debug('Contract does not exist, skipping detection', {
        address: tokenAddress,
        blockNumber: options.blockNumber,
      });
      return this.createEmptyResult();
    }

    const result: TokenDetectionResult = {
      isERC20: false,
      isERC721: false,
      isERC1155: false,
      supportedInterfaces: [],
      detectedType: null,
      confidence: 0,
    };

    try {
      if (options.useERC165 !== false) {
        // Try ERC165 detection first
        const erc165Result = await this.detectViaERC165(tokenAddress);
        if (erc165Result.confidence > 0) {
          return erc165Result;
        }
      }

      if (options.fallbackMethods !== false) {
        // Fallback to method-based detection
        const fallbackResult = await this.detectViaMethodCalls(tokenAddress, options.blockNumber);
        return fallbackResult;
      }

      return result;

    } catch (error) {
      logger.warn('Detection failed', {
        address: tokenAddress,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return result;
    }
  }

  private async detectViaERC165(tokenAddress: string): Promise<TokenDetectionResult> {
    const result = this.createEmptyResult();

    try {
      const supportsERC165 = await this.supportsERC165(tokenAddress);
      if (!supportsERC165) {
        return result;
      }

      // Check all interfaces in parallel
      const [isERC20, isERC721, isERC1155] = await Promise.all([
        this.supportsInterface(tokenAddress, TokenDetectionService.ERC20_INTERFACE_ID),
        this.supportsInterface(tokenAddress, TokenDetectionService.ERC721_INTERFACE_ID),
        this.supportsInterface(tokenAddress, TokenDetectionService.ERC1155_INTERFACE_ID),
      ]);

      result.isERC20 = isERC20;
      result.isERC721 = isERC721;
      result.isERC1155 = isERC1155;

      // Determine primary type and confidence
      if (isERC1155) {
        result.detectedType = TokenType.ERC1155;
        result.supportedInterfaces.push('ERC1155');
        result.confidence = 0.95; // High confidence for ERC165
      } else if (isERC721) {
        result.detectedType = TokenType.ERC721;
        result.supportedInterfaces.push('ERC721');
        result.confidence = 0.95;
      } else if (isERC20) {
        result.detectedType = TokenType.ERC20;
        result.supportedInterfaces.push('ERC20');
        result.confidence = 0.95;
      }

      logger.debug('ERC165 detection completed', {
        address: tokenAddress,
        isERC20,
        isERC721,
        isERC1155,
        detectedType: result.detectedType,
        confidence: result.confidence,
      });

      return result;

    } catch (error) {
      logger.debug('ERC165 detection failed', {
        address: tokenAddress,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return result;
    }
  }

  private async detectViaMethodCalls(
    tokenAddress: string,
    blockNumber?: number
  ): Promise<TokenDetectionResult> {
    const result = this.createEmptyResult();

    try {
      // Test methods in order of specificity
      const erc1155Score = await this.testERC1155Methods(tokenAddress, blockNumber);
      const erc721Score = await this.testERC721Methods(tokenAddress, blockNumber);
      const erc20Score = await this.testERC20Methods(tokenAddress, blockNumber);

      // Choose the type with the highest score
      const maxScore = Math.max(erc20Score, erc721Score, erc1155Score);

      if (maxScore > 0.5) {
        if (erc1155Score === maxScore) {
          result.isERC1155 = true;
          result.detectedType = TokenType.ERC1155;
          result.supportedInterfaces.push('ERC1155');
        } else if (erc721Score === maxScore) {
          result.isERC721 = true;
          result.detectedType = TokenType.ERC721;
          result.supportedInterfaces.push('ERC721');
        } else if (erc20Score === maxScore) {
          result.isERC20 = true;
          result.detectedType = TokenType.ERC20;
          result.supportedInterfaces.push('ERC20');
        }

        result.confidence = maxScore * 0.8; // Lower confidence than ERC165
      }

      logger.debug('Method-based detection completed', {
        address: tokenAddress,
        erc20Score,
        erc721Score,
        erc1155Score,
        detectedType: result.detectedType,
        confidence: result.confidence,
      });

      return result;

    } catch (error) {
      logger.debug('Method-based detection failed', {
        address: tokenAddress,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return result;
    }
  }

  private async testERC20Methods(tokenAddress: string, blockNumber?: number): Promise<number> {
    const context = this.createChainContext(blockNumber);
    const block = this.createBlock(blockNumber);
    const contract = new erc20.Contract(context, block, tokenAddress);

    const methods = [
      () => contract.name(),
      () => contract.symbol(),
      () => contract.decimals(),
      () => contract.totalSupply(),
    ];

    let successCount = 0;
    for (const method of methods) {
      const result = await this.safeCallWithValidation(method);
      if (result) successCount++;
    }

    return successCount / methods.length;
  }

  private async testERC721Methods(tokenAddress: string, blockNumber?: number): Promise<number> {
    const context = this.createChainContext(blockNumber);
    const block = this.createBlock(blockNumber);
    const contract = new erc721.Contract(context, block, tokenAddress);

    const methods = [
      () => contract.name(),
      () => contract.symbol(),
    ];

    let successCount = 0;
    for (const method of methods) {
      const result = await this.safeCallWithValidation(method);
      if (result) successCount++;
    }

    return successCount / methods.length;
  }

  private async testERC1155Methods(tokenAddress: string, blockNumber?: number): Promise<number> {
    const context = this.createChainContext(blockNumber);
    const block = this.createBlock(blockNumber);
    const contract = new erc1155.Contract(context, block, tokenAddress);

    try {
      const uri = await this.safeCallWithValidation(() => contract.uri(0n));
      return uri ? 1.0 : 0.0;
    } catch {
      return 0.0;
    }
  }

  private async safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  private async safeCallWithValidation(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      const result = await fn();
      
      // Validate result is not empty/invalid
      if (result === null || result === undefined) {
        return false;
      }
      
      if (typeof result === 'string' && result.trim().length === 0) {
        return false;
      }
      
      return true;
    } catch (error) {
      // Check for specific "could not decode result data" error
      if (error instanceof Error && error.message.includes('could not decode result data')) {
        return false;
      }
      return false;
    }
  }

  private createChainContext(blockNumber?: number): ChainContext {
    return {
      _chain: {
        client: this.rpcClient,
      },
    };
  }

  private createBlock(blockNumber?: number): Block {
    return {
      height: blockNumber || 0,
    };
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