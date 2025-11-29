import { ethers } from 'ethers';
import { logger } from '../../utils/logger';
import {
  BlockTipData,
  TipRevenueRawRecord,
  formatClickHouseDateTime,
  weiToMon
} from './types';

/**
 * TipRevenueService
 * Core service for fetching and calculating tip revenue from blockchain RPC
 *
 * NOTE: validator_id mapping is handled via JOIN with block_proposals table
 * at query time, not during ingestion.
 */
export class TipRevenueService {
  private provider: ethers.JsonRpcProvider;
  private isInitialized = false;

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Initialize the service and test RPC connection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Initializing TipRevenueService...');

      // Test connection
      const blockNumber = await this.provider.getBlockNumber();
      logger.info(`TipRevenueService connected to RPC. Current block: ${blockNumber}`);

      this.isInitialized = true;
      logger.info('TipRevenueService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize TipRevenueService:', error);
      throw error;
    }
  }

  /**
   * Get current block number from RPC
   */
  async getCurrentBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  /**
   * Fetch tip data for a single block
   * @param blockNumber Block number to fetch
   * @returns BlockTipData or null if block not found
   */
  async fetchBlockTipData(blockNumber: number): Promise<BlockTipData | null> {
    try {
      // Fetch block with full transaction details
      const block = await this.provider.getBlock(blockNumber, true);

      if (!block) {
        logger.warn(`Block ${blockNumber} not found`);
        return null;
      }

      const proposerAddress = block.miner;
      const baseFeePerGas = block.baseFeePerGas || BigInt(0);
      const blockTimestamp = new Date(Number(block.timestamp) * 1000);

      let totalTipWei = BigInt(0);
      let transactionCount = 0;

      // Process each transaction to calculate tips
      if (block.prefetchedTransactions && block.prefetchedTransactions.length > 0) {
        transactionCount = block.prefetchedTransactions.length;

        // Batch fetch transaction receipts for efficiency
        const receiptPromises = block.prefetchedTransactions.map(tx =>
          this.provider.getTransactionReceipt(tx.hash)
        );

        const receipts = await Promise.all(receiptPromises);

        for (let i = 0; i < receipts.length; i++) {
          const receipt = receipts[i];
          const tx = block.prefetchedTransactions[i];

          if (!receipt) continue;

          // Monad tip calculation: priority_fee × gasLimit
          // Monad charges based on gasLimit not gasUsed (for asynchronous block execution)
          // Source: https://docs.monad.xyz/developer-essentials/gas-pricing
          // Note: ethers.js maps RPC's effectiveGasPrice to receipt.gasPrice
          const effectiveGasPrice = receipt.gasPrice ?? tx.gasPrice ?? BigInt(0);
          const gasLimit = tx.gasLimit;

          // Priority fee per gas = effectiveGasPrice - baseFeePerGas
          const tipPerGas = effectiveGasPrice > baseFeePerGas
            ? effectiveGasPrice - baseFeePerGas
            : BigInt(0);

          // Total tip for this transaction = tipPerGas × gasLimit
          const txTip = tipPerGas * gasLimit;
          totalTipWei += txTip;
        }
      }

      return {
        blockNumber,
        blockTimestamp,
        validatorId: null, // Resolved via JOIN with block_proposals at query time
        proposerAddress,
        totalTipWei,
        transactionCount,
        baseFeePerGas
      };
    } catch (error) {
      logger.error(`Failed to fetch tip data for block ${blockNumber}:`, error);
      return null;
    }
  }

  /**
   * Fetch tip data for a range of blocks
   * @param fromBlock Start block (inclusive)
   * @param toBlock End block (inclusive)
   * @returns Array of BlockTipData
   */
  async fetchBlockRange(fromBlock: number, toBlock: number): Promise<BlockTipData[]> {
    const results: BlockTipData[] = [];
    const batchSize = 10; // Process in batches to avoid overwhelming RPC

    for (let start = fromBlock; start <= toBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toBlock);
      const blockNumbers = Array.from(
        { length: end - start + 1 },
        (_, i) => start + i
      );

      // Fetch blocks in parallel within batch
      const promises = blockNumbers.map(blockNum => this.fetchBlockTipData(blockNum));
      const blockResults = await Promise.all(promises);

      // Filter out null results and add to results
      for (const result of blockResults) {
        if (result) {
          results.push(result);
        }
      }

      // Small delay between batches to avoid rate limiting
      if (end < toBlock) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  /**
   * Convert BlockTipData to database record format
   * NOTE: validator_id is left empty - it will be resolved via JOIN at query time
   */
  blockTipDataToRecord(data: BlockTipData): TipRevenueRawRecord {
    return {
      block_number: data.blockNumber,
      block_timestamp: formatClickHouseDateTime(data.blockTimestamp),
      validator_id: '', // Resolved via JOIN with block_proposals at query time
      proposer_address: data.proposerAddress,
      total_tip_wei: data.totalTipWei.toString(),
      transaction_count: data.transactionCount,
      base_fee_per_gas: data.baseFeePerGas.toString()
    };
  }

  /**
   * Process a block range and insert into database
   * @returns Number of blocks processed
   */
  async processBlockRange(
    fromBlock: number,
    toBlock: number,
    clickhouseClient: any
  ): Promise<number> {
    logger.info(`Processing tip revenue for blocks ${fromBlock} to ${toBlock}`);

    // Fetch block data
    const blockData = await this.fetchBlockRange(fromBlock, toBlock);

    if (blockData.length === 0) {
      logger.warn(`No blocks found in range ${fromBlock}-${toBlock}`);
      return 0;
    }

    // Convert to records (validator_id will be resolved via JOIN at query time)
    const records: TipRevenueRawRecord[] = blockData.map(block =>
      this.blockTipDataToRecord(block)
    );

    // Insert into database
    if (records.length > 0) {
      await clickhouseClient.insertTipRevenueRaw(records);
      logger.info(`Inserted ${records.length} tip revenue records`);
    }

    return records.length;
  }

  /**
   * Calculate aggregated tip statistics for a validator
   */
  static calculateTipStats(
    tipWeiTotal: bigint,
    blocksProposed: number,
    transactionsTotal: number
  ): {
    totalTipMon: string;
    avgTipPerBlockWei: string;
    avgTipPerBlockMon: string;
    avgTipPerTxWei: string;
    avgTipPerTxMon: string;
  } {
    const totalTipMon = weiToMon(tipWeiTotal, 6);

    const avgTipPerBlockWei = blocksProposed > 0
      ? (tipWeiTotal / BigInt(blocksProposed)).toString()
      : '0';

    const avgTipPerBlockMon = blocksProposed > 0
      ? weiToMon(tipWeiTotal / BigInt(blocksProposed), 6)
      : '0.000000';

    const avgTipPerTxWei = transactionsTotal > 0
      ? (tipWeiTotal / BigInt(transactionsTotal)).toString()
      : '0';

    const avgTipPerTxMon = transactionsTotal > 0
      ? weiToMon(tipWeiTotal / BigInt(transactionsTotal), 8)
      : '0.00000000';

    return {
      totalTipMon,
      avgTipPerBlockWei,
      avgTipPerBlockMon,
      avgTipPerTxWei,
      avgTipPerTxMon
    };
  }
}
