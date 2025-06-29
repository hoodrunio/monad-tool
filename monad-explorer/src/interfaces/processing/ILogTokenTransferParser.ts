export interface ParsedTokenTransfer {
  id: string;
  tokenAddress: string;
  fromAddress: string;
  toAddress: string;
  value: bigint;
  tokenType: 'ERC20' | 'ERC721' | 'ERC1155';
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: Date;
  // Computed fields (no DB storage)
  tokenId?: string;
  tokenMetadata?: {
    name?: string;
    symbol?: string;
    decimals?: number;
  };
}

export interface TokenTransferParsingResult {
  transfers: ParsedTokenTransfer[];
  processedLogs: number;
  errors: Array<{
    logId: string;
    error: string;
  }>;
}

export interface LogTokenTransferParsingOptions {
  includeMetadata?: boolean;
  blockNumber?: number;
  includeTokenInfo?: boolean;
}

export interface ILogTokenTransferParser {
  /**
   * Parse token transfers from transaction logs
   */
  parseTransfersFromLogs(
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
    options?: LogTokenTransferParsingOptions
  ): Promise<TokenTransferParsingResult>;

  /**
   * Parse single log for token transfer
   */
  parseTransferFromLog(
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
    options?: LogTokenTransferParsingOptions
  ): Promise<ParsedTokenTransfer | null>;

  /**
   * Check if log represents a token transfer
   */
  isTokenTransferLog(log: {
    topics: string[];
    address: string;
  }): boolean;

  /**
   * Get supported transfer event signatures
   */
  getSupportedSignatures(): string[];
} 