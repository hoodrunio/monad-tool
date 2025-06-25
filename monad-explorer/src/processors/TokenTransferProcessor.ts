import { Token, TokenTransfer, Log, Transaction, TokenType } from '../model'
import { Log as SquidLog } from '../processor'

/**
 * Token Transfer Processor following Single Responsibility Principle
 * Responsible only for processing token transfer events
 */
export class TokenTransferProcessor {
  private readonly tokens: Map<string, Token> = new Map()

  /**
   * Processes a token transfer log into TokenTransfer entity
   * @param log - Log data from processor
   * @param transaction - Parent transaction entity
   * @param logEntity - Log entity
   * @returns TokenTransfer entity ready for database storage
   */
  processTokenTransfer(log: SquidLog, transaction: Transaction, logEntity: Log): TokenTransfer {
    const tokenAddress = log.address.toLowerCase()
    const fromAddress = '0x' + log.topics[1].slice(26)
    const toAddress = '0x' + log.topics[2].slice(26)
    
    let value: bigint
    try {
      value = BigInt(log.data || '0x0')
    } catch {
      value = 0n
    }

    // Create or get token
    const token = this.getOrCreateToken(tokenAddress, transaction.timestamp)

    return new TokenTransfer({
      id: `${transaction.hash}-${log.logIndex}`,
      token: token,
      transaction: transaction,
      log: logEntity,
      fromAddress: fromAddress,
      toAddress: toAddress,
      value: value,
      tokenId: null,
      timestamp: transaction.timestamp,
    })
  }

  /**
   * Gets or creates a token entity
   * @param tokenAddress - Token contract address
   * @param timestamp - Transaction timestamp
   * @returns Token entity
   */
  private getOrCreateToken(tokenAddress: string, timestamp: Date): Token {
    if (!this.tokens.has(tokenAddress)) {
      this.tokens.set(tokenAddress, new Token({
        id: tokenAddress,
        address: tokenAddress,
        name: null, // Will be enriched by background service
        symbol: null, // Will be enriched by background service
        decimals: null, // Will be enriched by background service
        totalSupply: null, // Will be enriched by background service
        tokenType: TokenType.UNKNOWN, // Will be enriched by background service
        createdAt: timestamp,
      }))
    }

    return this.tokens.get(tokenAddress)!
  }

  /**
   * Gets all processed tokens
   * @returns Array of processed token entities
   */
  getProcessedTokens(): Token[] {
    return [...this.tokens.values()]
  }

  /**
   * Clears the internal tokens cache
   */
  clear(): void {
    this.tokens.clear()
  }

  /**
   * Gets the number of processed tokens
   * @returns Number of processed tokens
   */
  getTokenCount(): number {
    return this.tokens.size
  }
} 