import { Log, Transaction } from '../model'
import { Log as SquidLog } from '../processor'

/**
 * Log Processor following Single Responsibility Principle
 * Responsible only for processing blockchain event logs
 */
export class LogProcessor {
  /**
   * Processes a single log into Log entity
   * @param log - Log data from processor
   * @param transaction - Parent transaction entity
   * @returns Log entity ready for database storage
   */
  processLog(log: SquidLog, transaction: Transaction): Log {
    return new Log({
      id: `${transaction.hash}-${log.logIndex}`,
      transaction: transaction,
      logIndex: log.logIndex,
      address: log.address,
      topics: log.topics,
      data: log.data,
      removed: false,
    })
  }

  /**
   * Checks if log is a token transfer event
   * @param log - Log data from processor
   * @returns Boolean indicating if log is a token transfer
   */
  isTokenTransfer(log: SquidLog): boolean {
    const ERC20_TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    return log.topics[0] === ERC20_TRANSFER_SIGNATURE && log.topics.length >= 3
  }

  /**
   * Processes multiple logs for a transaction
   * @param logs - Array of log data from processor
   * @param transaction - Parent transaction entity
   * @returns Array of log entities ready for database storage
   */
  processLogs(logs: SquidLog[], transaction: Transaction): Log[] {
    return logs.map(log => this.processLog(log, transaction))
  }
} 