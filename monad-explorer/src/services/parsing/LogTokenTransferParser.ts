import { 
  ILogTokenTransferParser,
  ParsedTokenTransfer, 
  TokenTransferParsingResult,
  LogTokenTransferParsingOptions 
} from '../../interfaces/processing/ILogTokenTransferParser';
import { IEventTokenDetector } from '../../interfaces/services/IEventTokenDetector';
import { ITokenRepository } from '../../interfaces/services/ITokenRepository';
import { TokenType } from '../../model/generated/_tokenType';
import { logger } from '../../utils/logger';

export class LogTokenTransferParser implements ILogTokenTransferParser {
  // ERC20/ERC721 Transfer(address,address,uint256)
  private static readonly TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  
  // ERC1155 TransferSingle(address,address,address,uint256,uint256)
  private static readonly TRANSFER_SINGLE_SIGNATURE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
  
  // ERC1155 TransferBatch(address,address,address,uint256[],uint256[])
  private static readonly TRANSFER_BATCH_SIGNATURE = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

  private static readonly SUPPORTED_SIGNATURES = [
    LogTokenTransferParser.TRANSFER_SIGNATURE,
    LogTokenTransferParser.TRANSFER_SINGLE_SIGNATURE,
    LogTokenTransferParser.TRANSFER_BATCH_SIGNATURE
  ];

  constructor(
    private readonly eventDetector: IEventTokenDetector,
    private readonly tokenRepository: ITokenRepository
  ) {}

  public async parseTransfersFromLogs(
    logs: Array<{
      id: string;
      address: string;
      topics: string[];
      data: string;
      logIndex: number;
      transaction: {
        hash: string;
        blockNumber: number;
        timestamp: Date;
      };
    }>,
    options: LogTokenTransferParsingOptions = {}
  ): Promise<TokenTransferParsingResult> {
    const startTime = Date.now();
    const transfers: ParsedTokenTransfer[] = [];
    const errors: Array<{ logId: string; error: string }> = [];
    let processedLogs = 0;

    logger.debug('Starting log token transfer parsing', {
      totalLogs: logs.length,
      options
    });

    for (const log of logs) {
      try {
        if (this.isTokenTransferLog(log)) {
          const transfer = await this.parseTransferFromLog(log, options);
          if (transfer) {
            transfers.push(transfer);
          }
          processedLogs++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push({
          logId: log.id,
          error: errorMessage
        });
        
        logger.warn('Failed to parse token transfer from log', {
          logId: log.id,
          address: log.address,
          error: errorMessage
        });
      }
    }

    const duration = Date.now() - startTime;
    
    logger.info('Log token transfer parsing completed', {
      totalLogs: logs.length,
      processedLogs,
      transfersFound: transfers.length,
      errors: errors.length,
      duration
    });

    return {
      transfers,
      processedLogs,
      errors
    };
  }

  public async parseTransferFromLog(
    log: {
      id: string;
      address: string;
      topics: string[];
      data: string;
      logIndex: number;
      transaction: {
        hash: string;
        blockNumber: number;
        timestamp: Date;
      };
    },
    options: LogTokenTransferParsingOptions = {}
  ): Promise<ParsedTokenTransfer | null> {
    if (!this.isTokenTransferLog(log)) {
      return null;
    }

    const transferId = `${log.transaction.hash}-${log.logIndex}`;
    
    try {
      // Detect token type from log structure
      const detection = this.eventDetector.detectFromTransferEvent({
        address: log.address,
        topics: log.topics,
        data: log.data
      });

      if (!detection) {
        return null;
      }

      // Parse transfer data based on token type
      const transfer = await this.parseTransferByType(log, detection.tokenType, transferId, options);
      
      return transfer;
    } catch (error) {
      logger.error('Error parsing transfer from log', {
        logId: log.id,
        address: log.address,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  public isTokenTransferLog(log: {
    topics: string[];
    address: string;
  }): boolean {
    if (!log.topics || log.topics.length === 0) {
      return false;
    }

    const eventSignature = log.topics[0];
    return LogTokenTransferParser.SUPPORTED_SIGNATURES.includes(eventSignature);
  }

  public getSupportedSignatures(): string[] {
    return [...LogTokenTransferParser.SUPPORTED_SIGNATURES];
  }

  private async parseTransferByType(
    log: {
      id: string;
      address: string;
      topics: string[];
      data: string;
      logIndex: number;
      transaction: {
        hash: string;
        blockNumber: number;
        timestamp: Date;
      };
    },
    tokenType: TokenType,
    transferId: string,
    options: LogTokenTransferParsingOptions
  ): Promise<ParsedTokenTransfer | null> {
    const eventSignature = log.topics[0];
    
    if (eventSignature === LogTokenTransferParser.TRANSFER_SIGNATURE) {
      // ERC20/ERC721 Transfer
      return this.parseERC20OrERC721Transfer(log, tokenType, transferId, options);
    } else if (eventSignature === LogTokenTransferParser.TRANSFER_SINGLE_SIGNATURE) {
      // ERC1155 TransferSingle
      return this.parseERC1155SingleTransfer(log, transferId, options);
    } else if (eventSignature === LogTokenTransferParser.TRANSFER_BATCH_SIGNATURE) {
      // ERC1155 TransferBatch - For now, we'll skip batch transfers
      // TODO: Implement batch transfer parsing
      logger.debug('Skipping ERC1155 batch transfer parsing', {
        logId: log.id,
        address: log.address
      });
      return null;
    }

    return null;
  }

  private async parseERC20OrERC721Transfer(
    log: {
      id: string;
      address: string;
      topics: string[];
      data: string;
      logIndex: number;
      transaction: {
        hash: string;
        blockNumber: number;
        timestamp: Date;
      };
    },
    tokenType: TokenType,
    transferId: string,
    options: LogTokenTransferParsingOptions
  ): Promise<ParsedTokenTransfer | null> {
    // Transfer(address indexed from, address indexed to, uint256 value)
    if (log.topics.length !== 3) {
      return null;
    }

    const fromAddress = this.parseAddressFromTopic(log.topics[1]);
    const toAddress = this.parseAddressFromTopic(log.topics[2]);
    const value = this.parseValueFromData(log.data);

    if (!fromAddress || !toAddress || value === null) {
      return null;
    }

    const transfer: ParsedTokenTransfer = {
      id: transferId,
      tokenAddress: log.address.toLowerCase(),
      fromAddress,
      toAddress,
      value,
      tokenType: tokenType === TokenType.ERC721 ? 'ERC721' : 'ERC20',
      transactionHash: log.transaction.hash,
      logIndex: log.logIndex,
      blockNumber: log.transaction.blockNumber,
      timestamp: log.transaction.timestamp
    };

    // For ERC721, the value is actually the tokenId
    if (tokenType === TokenType.ERC721) {
      transfer.tokenId = value.toString();
    }

    // Optionally include token metadata
    if (options.includeTokenInfo) {
      await this.enrichTransferWithTokenInfo(transfer);
    }

    return transfer;
  }

  private async parseERC1155SingleTransfer(
    log: {
      id: string;
      address: string;
      topics: string[];
      data: string;
      logIndex: number;
      transaction: {
        hash: string;
        blockNumber: number;
        timestamp: Date;
      };
    },
    transferId: string,
    options: LogTokenTransferParsingOptions
  ): Promise<ParsedTokenTransfer | null> {
    // TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)
    if (log.topics.length !== 4) {
      return null;
    }

    const fromAddress = this.parseAddressFromTopic(log.topics[2]);
    const toAddress = this.parseAddressFromTopic(log.topics[3]);
    
    // Parse data: id (32 bytes) + value (32 bytes)
    const dataWithoutPrefix = log.data.slice(2); // Remove 0x
    if (dataWithoutPrefix.length < 128) { // 64 hex chars * 2
      return null;
    }

    const tokenIdHex = dataWithoutPrefix.slice(0, 64);
    const valueHex = dataWithoutPrefix.slice(64, 128);

    const tokenId = BigInt('0x' + tokenIdHex);
    const value = BigInt('0x' + valueHex);

    if (!fromAddress || !toAddress) {
      return null;
    }

    const transfer: ParsedTokenTransfer = {
      id: transferId,
      tokenAddress: log.address.toLowerCase(),
      fromAddress,
      toAddress,
      value,
      tokenType: 'ERC1155',
      transactionHash: log.transaction.hash,
      logIndex: log.logIndex,
      blockNumber: log.transaction.blockNumber,
      timestamp: log.transaction.timestamp,
      tokenId: tokenId.toString()
    };

    // Optionally include token metadata
    if (options.includeTokenInfo) {
      await this.enrichTransferWithTokenInfo(transfer);
    }

    return transfer;
  }

  private parseAddressFromTopic(topic: string): string | null {
    if (!topic || topic.length !== 66) { // 0x + 64 hex chars
      return null;
    }

    // Address is in the last 20 bytes (40 hex chars)
    const address = '0x' + topic.slice(26).toLowerCase();
    
    // Basic validation
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return null;
    }

    return address;
  }

  private parseValueFromData(data: string): bigint | null {
    if (!data || data.length < 66) { // 0x + 64 hex chars minimum
      return null;
    }

    try {
      return BigInt(data);
    } catch (error) {
      logger.warn('Failed to parse value from log data', {
        data,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  private async enrichTransferWithTokenInfo(transfer: ParsedTokenTransfer): Promise<void> {
    try {
      const tokenInfo = await this.tokenRepository.get(transfer.tokenAddress);
      
      if (tokenInfo) {
        transfer.tokenMetadata = {
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals
        };
      }
    } catch (error) {
      logger.warn('Failed to enrich transfer with token info', {
        tokenAddress: transfer.tokenAddress,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      // Don't throw - enrichment is optional
    }
  }
} 