import { TokenType } from '../../model';
import { LogEvent } from './IEventTokenDetector';

export interface TokenDetectionResult {
  isERC20: boolean;
  isERC721: boolean;
  isERC1155: boolean;
  supportedInterfaces: string[];
  detectedType: TokenType | null;
  confidence: number; // 0-1 confidence score
}

export interface TokenDetectionOptions {
  blockNumber?: number;
  transferLog?: LogEvent; // Event-based detection
  useERC165?: boolean;
  fallbackMethods?: boolean;
  timeout?: number;
}

export interface ITokenDetectionService {
  /**
   * Detect token type and supported interfaces
   */
  detectTokenType(
    tokenAddress: string, 
    options?: TokenDetectionOptions
  ): Promise<TokenDetectionResult>;

  /**
   * Check if contract exists at specific block
   */
  contractExists(
    tokenAddress: string, 
    blockNumber?: number
  ): Promise<boolean>;

  /**
   * Get detection statistics
   */
  getStats(): {
    totalDetections: number;
    successfulDetections: number;
    erc20Count: number;
    erc721Count: number;
    erc1155Count: number;
    unknownCount: number;
    averageConfidence: number;
    cacheHitRate: number;
    errorCount: number;
  };
} 