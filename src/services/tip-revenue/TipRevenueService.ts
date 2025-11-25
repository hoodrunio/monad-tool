import { ethers, keccak256 } from 'ethers';
import { logger } from '../../utils/logger';
import * as secp256k1 from 'secp256k1';
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
  private validatorIdToAddressCache: Map<string, string> = new Map();

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
   * Convert compressed secp256k1 public key to Ethereum address
   * validator_id (compressed pubkey) -> decompress -> keccak256 -> last 20 bytes
   * @param compressedPubKey Compressed public key (33 bytes hex with 0x prefix)
   * @returns Ethereum address (0x prefixed)
   */
  compressedPubKeyToAddress(compressedPubKey: string): string | null {
    try {
      // Remove 0x prefix if present
      const pubKeyHex = compressedPubKey.startsWith('0x')
        ? compressedPubKey.slice(2)
        : compressedPubKey;

      // Convert hex to Uint8Array
      const compressedBytes = Uint8Array.from(
        Buffer.from(pubKeyHex, 'hex')
      );

      // Decompress the public key (33 bytes -> 65 bytes)
      const uncompressedBytes = secp256k1.publicKeyConvert(compressedBytes, false);

      // Remove the first byte (0x04 prefix) to get 64 bytes
      const pubKeyWithoutPrefix = uncompressedBytes.slice(1);

      // Keccak256 hash of the uncompressed public key (without 0x04 prefix)
      const hash = keccak256(pubKeyWithoutPrefix);

      // Take last 20 bytes (40 hex chars) as the address
      const address = '0x' + hash.slice(-40);

      return address.toLowerCase();
    } catch (error) {
      logger.warn(`Failed to convert compressed pubkey to address: ${compressedPubKey}`, error);
      return null;
    }
  }

  /**
   * Build validator address mapping cache from database
   * Converts all validator_ids to Ethereum addresses for fast lookup
   */
  async buildValidatorAddressCache(clickhouseClient: any): Promise<void> {
    try {
      // Get all validator_ids from database
      const query = `
        SELECT DISTINCT validator_id
        FROM validator_registry
        WHERE validator_id != ''
      `;

      const result = await clickhouseClient.executeRawQuery(query);

      for (const row of result) {
        const validatorId = row.validator_id;
        const address = this.compressedPubKeyToAddress(validatorId);

        if (address) {
          this.validatorIdToAddressCache.set(validatorId, address);
          this.addressToValidatorCache.set(address, validatorId);
        }
      }

      logger.info(`Built validator address cache with ${this.validatorIdToAddressCache.size} entries`);
    } catch (error) {
      logger.error('Failed to build validator address cache:', error);
    }
  }

  /**
   * Map proposer address to validator_id
   * Converts miner address to validator_id using precomputed cache
   * @param proposerAddress Block proposer/miner address (Ethereum address)
   * @param clickhouseClient ClickHouse client for database queries
   * @returns validator_id or null if not found
   */
  async mapProposerToValidator(
    proposerAddress: string,
    clickhouseClient: any
  ): Promise<string | null> {
    const normalizedAddress = proposerAddress.toLowerCase();

    // Check cache first
    if (this.addressToValidatorCache.has(normalizedAddress)) {
      return this.addressToValidatorCache.get(normalizedAddress) || null;
    }

    // If cache is empty, build it
    if (this.validatorIdToAddressCache.size === 0) {
      await this.buildValidatorAddressCache(clickhouseClient);
    }

    // Check cache again after building
    if (this.addressToValidatorCache.has(normalizedAddress)) {
      return this.addressToValidatorCache.get(normalizedAddress) || null;
    }

    // If still not found, try to find new validators
    try {
      const query = `
        SELECT DISTINCT validator_id
        FROM validator_registry
        WHERE validator_id != ''
          AND validator_id NOT IN (${
            Array.from(this.validatorIdToAddressCache.keys())
              .map(id => `'${id}'`)
              .join(',') || "''"
          })
      `;

      const result = await clickhouseClient.executeRawQuery(query);

      for (const row of result) {
        const validatorId = row.validator_id;
        const address = this.compressedPubKeyToAddress(validatorId);

        if (address) {
          this.validatorIdToAddressCache.set(validatorId, address);
          this.addressToValidatorCache.set(address, validatorId);

          if (address === normalizedAddress) {
            return validatorId;
          }
        }
      }
    } catch (error) {
      logger.warn(`Failed to map proposer ${proposerAddress} to validator:`, error);
    }

    // Cache the miss
    this.addressToValidatorCache.set(normalizedAddress, null);
    return null;
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
