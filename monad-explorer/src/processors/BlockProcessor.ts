import { Block } from '../model'
import { BlockHeader } from '@subsquid/evm-processor'
import { Fields } from '../processor'

/**
 * Block Processor following Single Responsibility Principle
 * Responsible only for processing blockchain blocks
 */
export class BlockProcessor {
  /**
   * Processes a single block header into Block entity
   * @param header - Block header from processor
   * @returns Block entity ready for database storage
   */
  processBlock(header: BlockHeader<Fields>): Block {
    return new Block({
      id: header.hash,
      number: header.height,
      hash: header.hash,
      parentHash: header.parentHash,
      timestamp: new Date(header.timestamp),
      size: BigInt(header.size || 0),
      gasLimit: BigInt(header.gasLimit || 0),
      gasUsed: BigInt(header.gasUsed || 0),
      transactionCount: 0, // Will be set by caller
      miner: header.miner || '',
      extraData: header.extraData || '0x',
      baseFeePerGas: BigInt(header.baseFeePerGas || 0),
    })
  }

  /**
   * Updates block with transaction count
   * @param block - Block entity to update
   * @param transactionCount - Number of transactions in block
   */
  updateTransactionCount(block: Block, transactionCount: number): void {
    block.transactionCount = transactionCount
  }
} 