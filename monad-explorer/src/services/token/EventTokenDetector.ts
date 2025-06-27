import { IEventTokenDetector, LogEvent, TokenDetectionFromEvent } from '../../interfaces/services/IEventTokenDetector';
import { TokenType } from '../../model';
import { logger } from '../../utils/logger';

/**
 * Event-based token detection using event signatures
 * No RPC calls needed - just log analysis
 */
export class EventTokenDetector implements IEventTokenDetector {
  // Standard Transfer event signature (ERC20 & ERC721)
  private static readonly TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  
  // ERC1155 event signatures
  private static readonly TRANSFER_SINGLE_SIGNATURE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
  private static readonly TRANSFER_BATCH_SIGNATURE = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
  
  private static readonly SUPPORTED_SIGNATURES = [
    EventTokenDetector.TRANSFER_SIGNATURE,
    EventTokenDetector.TRANSFER_SINGLE_SIGNATURE,
    EventTokenDetector.TRANSFER_BATCH_SIGNATURE,
  ];

  public detectFromTransferEvent(log: LogEvent): TokenDetectionFromEvent | null {
    if (!this.isTransferEvent(log)) {
      return null;
    }

    const signature = log.topics[0];

    try {
      switch (signature) {
        case EventTokenDetector.TRANSFER_SIGNATURE:
          return this.detectERC20orERC721(log);
          
        case EventTokenDetector.TRANSFER_SINGLE_SIGNATURE:
        case EventTokenDetector.TRANSFER_BATCH_SIGNATURE:
          return {
            tokenType: TokenType.ERC1155,
            confidence: 0.95,
            detectionMethod: 'event_signature',
          };
          
        default:
          return null;
      }
    } catch (error) {
      logger.debug('Event-based detection failed', {
        signature,
        address: log.address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  public isTransferEvent(log: LogEvent): boolean {
    return log.topics.length > 0 && 
           EventTokenDetector.SUPPORTED_SIGNATURES.includes(log.topics[0]);
  }

  public getSupportedSignatures(): string[] {
    return [...EventTokenDetector.SUPPORTED_SIGNATURES];
  }

  /**
   * Distinguish ERC20 vs ERC721 based on topics structure
   * - ERC20: Transfer(address indexed from, address indexed to, uint256 value)
   * - ERC721: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
   */
  private detectERC20orERC721(log: LogEvent): TokenDetectionFromEvent {
    // Both ERC20 and ERC721 have the same Transfer signature: Transfer(address,address,uint256)
    // The difference is in the indexing and data structure:
    
    if (log.topics.length === 4) {
      // ERC721: topics = [signature, from, to, tokenId] (tokenId is indexed)
      // ERC721 Transfer has tokenId as indexed parameter
      return {
        tokenType: TokenType.ERC721,
        confidence: 0.85,
        detectionMethod: 'event_structure',
      };
    } else if (log.topics.length === 3 && log.data && log.data !== '0x') {
      // ERC20: topics = [signature, from, to], data = value (value not indexed)
      // ERC20 Transfer has value in data field
      return {
        tokenType: TokenType.ERC20,
        confidence: 0.85,
        detectionMethod: 'event_structure',
      };
    }

    // Fallback: if unclear, default to ERC20 (more common)
    logger.debug('Ambiguous Transfer event structure, defaulting to ERC20', {
      address: log.address,
      topicsLength: log.topics.length,
      hasData: Boolean(log.data && log.data !== '0x'),
    });

    return {
      tokenType: TokenType.ERC20,
      confidence: 0.6,
      detectionMethod: 'event_structure',
    };
  }
} 