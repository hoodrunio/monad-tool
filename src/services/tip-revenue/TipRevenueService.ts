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
 */
export class TipRevenueService {
  private provider: ethers.JsonRpcProvider;
  private isInitialized = false;
  private addressToValidatorCache: Map<string, string | null> = new Map();

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

          // Calculate tip: (effectiveGasPrice - baseFeePerGas) * gasUsed
          // effectiveGasPrice is what was actually paid per gas
          const effectiveGasPrice = receipt.gasPrice || tx.gasPrice || BigInt(0);
          const gasUsed = receipt.gasUsed;

          // Tip per gas = effectiveGasPrice - baseFeePerGas
          const tipPerGas = effectiveGasPrice > baseFeePerGas
            ? effectiveGasPrice - baseFeePerGas
            : BigInt(0);

          // Total tip for this transaction
          const txTip = tipPerGas * gasUsed;
          totalTipWei += txTip;
        }
      }

      return {
        blockNumber,
        blockTimestamp,
        validatorId: null, // Will be resolved later via mapping
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
   * Map proposer address to validator_id using database lookup
   * @param proposerAddress Block proposer/miner address
   * @param clickhouseClient ClickHouse client for database queries
   * @returns validator_id or null if not found
   */
  async mapProposerToValidator(
    proposerAddress: string,
    clickhouseClient: any
  ): Promise<string | null> {
    // Check cache first
    const cacheKey = proposerAddress.toLowerCase();
    if (this.addressToValidatorCache.has(cacheKey)) {
      return this.addressToValidatorCache.get(cacheKey) || null;
    }

    try {
      // Query validator_registry for auth_address match
      const query = `
        SELECT validator_id
        FROM validator_registry FINAL
        WHERE lower(auth_address) = lower('${proposerAddress}')
        ORDER BY last_updated DESC
        LIMIT 1
      `;

      const result = await clickhouseClient.executeRawQuery(query);

      const validatorId = result[0]?.validator_id || null;

      // Cache the result (including null)
      this.addressToValidatorCache.set(cacheKey, validatorId);

      return validatorId;
    } catch (error) {
      logger.warn(`Failed to map proposer ${proposerAddress} to validator:`, error);
      return null;
    }
  }

  /**
   * Convert BlockTipData to database record format
   */
  blockTipDataToRecord(
    data: BlockTipData,
    validatorId: string | null
  ): TipRevenueRawRecord {
    return {
      block_number: data.blockNumber,
      block_timestamp: formatClickHouseDateTime(data.blockTimestamp),
      validator_id: validatorId || '',
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

    // Resolve validator IDs for all proposer addresses
    const records: TipRevenueRawRecord[] = [];

    for (const block of blockData) {
      const validatorId = await this.mapProposerToValidator(
        block.proposerAddress,
        clickhouseClient
      );

      const record = this.blockTipDataToRecord(block, validatorId);
      records.push(record);
    }

    // Insert into database
    if (records.length > 0) {
      await clickhouseClient.insertTipRevenueRaw(records);
      logger.info(`Inserted ${records.length} tip revenue records`);
    }

    return records.length;
  }

  /**
   * Clear address-to-validator cache
   */
  clearCache(): void {
    this.addressToValidatorCache.clear();
    logger.info('TipRevenueService cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; hitRate: number } {
    return {
      size: this.addressToValidatorCache.size,
      hitRate: 0 // TODO: Implement hit rate tracking if needed
    };
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
