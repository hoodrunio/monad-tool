// Monad Blockchain Indexer Service
// Indexes blocks, transactions, contracts, and tokens from Monad blockchain

import { EventEmitter } from 'events';
// import * as cron from 'node-cron';
import { MonadRpcClient, MonadRpcConfig, BlockData, TransactionData, ContractEventData } from './MonadRpcClient';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export interface IndexerConfig {
  rpc: MonadRpcConfig;
  indexing: {
    startBlock?: number;
    batchSize: number;
    concurrentRequests: number;
    retryAttempts: number;
    blockConfirmations: number;
    enableContractDetection: boolean;
    enableTokenTracking: boolean;
    enableNftMetadata: boolean;
  };
  cron: {
    enabled: boolean;
    schedule: string; // e.g., '*/10 * * * * *' for every 10 seconds
  };
}

export interface IndexingStats {
  latestBlock: number;
  processedBlocks: number;
  processedTransactions: number;
  discoveredContracts: number;
  discoveredTokens: number;
  indexingRate: number; // blocks per minute
  lastIndexedAt: Date;
  isIndexing: boolean;
}

export interface TokenTransfer {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  timestamp: number;
  tokenAddress: string;
  tokenType: 'erc20' | 'erc721' | 'erc1155';
  tokenName?: string;
  tokenSymbol?: string;
  fromAddress: string;
  toAddress: string;
  amount: bigint;
  tokenId?: bigint;
}

export class BlockchainIndexer extends EventEmitter {
  private rpcClient: MonadRpcClient;
  private clickhouseClient: MonadClickHouseClient;
  private redisClient: MonadRedisClient;
  private config: IndexerConfig;
  private indexerRunning: boolean = false;
  private cronJob?: any; // cron.ScheduledTask;
  private stats: IndexingStats;

  // Token signatures for event detection
  private readonly TOKEN_TRANSFER_SIGNATURES = {
    ERC20: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer(address,address,uint256)
    ERC721: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer(address,address,uint256)
    ERC1155_SINGLE: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', // TransferSingle
    ERC1155_BATCH: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'  // TransferBatch
  };

  constructor(
    config: IndexerConfig,
    clickhouseClient: MonadClickHouseClient,
    redisClient: MonadRedisClient
  ) {
    super();
    this.config = config;
    this.clickhouseClient = clickhouseClient;
    this.redisClient = redisClient;

    this.rpcClient = new MonadRpcClient(config.rpc);

    this.stats = {
      latestBlock: 0,
      processedBlocks: 0,
      processedTransactions: 0,
      discoveredContracts: 0,
      discoveredTokens: 0,
      indexingRate: 0,
      lastIndexedAt: new Date(),
      isIndexing: false
    };
  }

  // =============================================
  // SERVICE LIFECYCLE
  // =============================================

  async start(): Promise<void> {
    try {
      logger.info('🚀 Starting Blockchain Indexer...');

      // Connect to RPC
      await this.rpcClient.connect();

      // Load starting block from database or config
      const latestProcessedBlock = await this.clickhouseClient.getLatestProcessedBlock();
      const startBlock = Math.max(
        latestProcessedBlock + 1,
        this.config.indexing.startBlock || 0
      );

      logger.info(`📦 Starting indexing from block ${startBlock}`);

      // Start initial sync
      await this.syncToLatest(startBlock);

      // Setup cron job for continuous indexing
      if (this.config.cron.enabled) {
        this.setupCronJob();
      }

      this.indexerRunning = true;
      this.emit('started');

      logger.info('✅ Blockchain Indexer started successfully');

    } catch (error) {
      logger.error('❌ Failed to start Blockchain Indexer:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info('🛑 Stopping Blockchain Indexer...');
    
    this.indexerRunning = false;
    
    if (this.cronJob) {
      // this.cronJob.stop();
      this.cronJob = undefined;
    }

    await this.rpcClient.disconnect();
    
    this.emit('stopped');
    logger.info('✅ Blockchain Indexer stopped');
  }

  // =============================================
  // INDEXING OPERATIONS
  // =============================================

  private async syncToLatest(startBlock: number): Promise<void> {
    try {
      const latestNetworkBlock = await this.rpcClient.getLatestBlockNumber();
      const targetBlock = latestNetworkBlock - this.config.indexing.blockConfirmations;

      if (startBlock > targetBlock) {
        logger.info(`📋 Already synced to block ${startBlock}`);
        return;
      }

      logger.info(`⏳ Syncing from block ${startBlock} to ${targetBlock}`);
      
      await this.indexBlockRange(startBlock, targetBlock);

    } catch (error) {
      logger.error('❌ Error during sync to latest:', error);
      throw error;
    }
  }

  async indexBlockRange(fromBlock: number, toBlock: number): Promise<void> {
    this.stats.isIndexing = true;
    const startTime = Date.now();

    try {
      for (let currentBlock = fromBlock; currentBlock <= toBlock; currentBlock += this.config.indexing.batchSize) {
        const batchEnd = Math.min(currentBlock + this.config.indexing.batchSize - 1, toBlock);
        
        logger.info(`📦 Processing blocks ${currentBlock} to ${batchEnd}`);
        
        await this.indexBlockBatch(currentBlock, batchEnd);
        
        // Update stats
        this.stats.processedBlocks += (batchEnd - currentBlock + 1);
        this.stats.latestBlock = batchEnd;
        this.stats.lastIndexedAt = new Date();
        
        // Emit progress event
        this.emit('progress', {
          processedBlocks: this.stats.processedBlocks,
          currentBlock: batchEnd,
          targetBlock: toBlock
        });
      }

      // Calculate indexing rate
      const duration = (Date.now() - startTime) / 1000 / 60; // minutes
      this.stats.indexingRate = this.stats.processedBlocks / duration;

      logger.info(`✅ Indexed blocks ${fromBlock} to ${toBlock} in ${duration.toFixed(2)} minutes`);

    } catch (error) {
      logger.error(`❌ Error indexing block range ${fromBlock}-${toBlock}:`, error);
      throw error;
    } finally {
      this.stats.isIndexing = false;
    }
  }

  private async indexBlockBatch(fromBlock: number, toBlock: number): Promise<void> {
    const blocks: BlockData[] = [];
    const allTransactions: TransactionData[] = [];
    const allEvents: ContractEventData[] = [];
    const allTransfers: TokenTransfer[] = [];
    const newAccounts: any[] = [];
    const newContracts: any[] = [];

    // Process blocks in batch
    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      try {
        await this.clickhouseClient.updateBlockProcessingStatus(blockNum, 'processing', {
          processingStartedAt: new Date()
        });

        const blockData = await this.indexSingleBlock(blockNum);
        
        if (blockData) {
          blocks.push(blockData.block);
          allTransactions.push(...blockData.transactions);
          allEvents.push(...blockData.events);
          allTransfers.push(...blockData.transfers);
          newAccounts.push(...blockData.accounts);
          newContracts.push(...blockData.contracts);

          await this.clickhouseClient.updateBlockProcessingStatus(blockNum, 'completed', {
            processingCompletedAt: new Date(),
            transactionsProcessed: blockData.transactions.length,
            eventsProcessed: blockData.events.length,
            contractsDiscovered: blockData.contracts.length,
            tokensDiscovered: blockData.transfers.length
          });
        }

      } catch (error) {
        logger.error(`❌ Error processing block ${blockNum}:`, error);
        
        await this.clickhouseClient.updateBlockProcessingStatus(blockNum, 'failed', {
          errorMessage: (error as Error).message,
          retryCount: 1
        });
      }
    }

    // Batch insert all data
    await this.batchInsertData({
      blocks,
      transactions: allTransactions,
      events: allEvents,
      transfers: allTransfers,
      accounts: newAccounts,
      contracts: newContracts
    });
  }

  private async indexSingleBlock(blockNumber: number): Promise<{
    block: BlockData;
    transactions: TransactionData[];
    events: ContractEventData[];
    transfers: TokenTransfer[];
    accounts: any[];
    contracts: any[];
  } | null> {
    try {
      // Get block data
      const block = await this.rpcClient.getBlock(blockNumber, true);
      if (!block) {
        logger.warn(`⚠️ Block ${blockNumber} not found`);
        return null;
      }

      // Get all transactions
      const transactions = await this.rpcClient.getTransactionsFromBlock(blockNumber);
      
      // Get block timestamp for events
      const blockTimestamp = block.timestamp;

      // Process transactions for events, contracts, and transfers
      const events: ContractEventData[] = [];
      const transfers: TokenTransfer[] = [];
      const accounts: any[] = [];
      const contracts: any[] = [];

      for (const tx of transactions) {
        // Add timestamp to transaction
        (tx as any).timestamp = blockTimestamp;

        // Process contract creation
        if (tx.createsContract && tx.contractAddress) {
          const contractData = await this.processNewContract(tx.contractAddress, tx, blockTimestamp);
          if (contractData) {
            contracts.push(contractData);
          }
        }

        // Get transaction receipt for events
        if (tx.status === 1) { // Only successful transactions
          try {
            const receipt = await this.rpcClient.getTransactionReceipt(tx.hash);
            if (receipt?.logs) {
              for (const log of receipt.logs) {
                const eventData = {
                  ...log,
                  timestamp: blockTimestamp
                };
                events.push(eventData as ContractEventData);

                // Check for token transfers
                const transfer = await this.extractTokenTransfer(log, blockTimestamp);
                if (transfer) {
                  transfers.push(transfer);
                }
              }
            }
          } catch (error) {
            logger.warn(`Failed to get receipt for tx ${tx.hash}:`, error);
          }
        }

        // Track accounts
        await this.trackAccount(tx.from, blockTimestamp, false, accounts);
        if (tx.to) {
          const isContract = await this.rpcClient.isContract(tx.to);
          await this.trackAccount(tx.to, blockTimestamp, isContract, accounts);
        }
      }

      return {
        block,
        transactions,
        events,
        transfers,
        accounts,
        contracts
      };

    } catch (error) {
      logger.error(`❌ Error indexing block ${blockNumber}:`, error);
      throw error;
    }
  }

  // =============================================
  // CONTRACT & TOKEN PROCESSING
  // =============================================

  private async processNewContract(contractAddress: string, creationTx: TransactionData, timestamp: number): Promise<any | null> {
    try {
      // Get contract code
      const code = await this.rpcClient.getContractCode(contractAddress);
      if (code === '0x') return null;

      // Try to get token info
      const tokenInfo = await this.rpcClient.getTokenInfo(contractAddress);

      const contractData = {
        address: contractAddress,
        isContract: true,
        contractType: tokenInfo.name ? 'erc20' : 'contract',
        contractCode: code,
        contractCreationTx: creationTx.hash,
        contractCreator: creationTx.from,
        firstSeen: new Date(timestamp * 1000),
        lastActivity: new Date(timestamp * 1000),
        tokenName: tokenInfo.name,
        tokenSymbol: tokenInfo.symbol,
        tokenDecimals: tokenInfo.decimals,
        tokenTotalSupply: tokenInfo.totalSupply,
        balance: 0n,
        nonce: 0,
        transactionCount: 1
      };

      this.stats.discoveredContracts++;

      if (tokenInfo.name) {
        this.stats.discoveredTokens++;
        logger.info(`🪙 New token discovered: ${tokenInfo.name} (${tokenInfo.symbol}) at ${contractAddress}`);
      }

      return contractData;

    } catch (error) {
      logger.warn(`Failed to process contract ${contractAddress}:`, error);
      return null;
    }
  }

  private async extractTokenTransfer(log: any, blockTimestamp: number): Promise<TokenTransfer | null> {
    try {
      if (!log.topics || log.topics.length === 0) return null;

      const signature = log.topics[0];

      // ERC-20/721 Transfer
      if (signature === this.TOKEN_TRANSFER_SIGNATURES.ERC20 && log.topics.length === 3) {
        const fromAddress = '0x' + log.topics[1].slice(26); // Remove padding
        const toAddress = '0x' + log.topics[2].slice(26);
        
        // Decode amount from data
        let amount: bigint;
        let tokenId: bigint | undefined;

        if (log.data && log.data !== '0x') {
          amount = BigInt(log.data);
          // If amount is 1, it might be ERC-721
          tokenId = amount === 1n ? amount : undefined;
        } else {
          amount = 1n; // Default for NFTs
        }

        // Get token info
        const tokenInfo = await this.rpcClient.getTokenInfo(log.address);

        return {
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: log.index,
          timestamp: blockTimestamp,
          tokenAddress: log.address,
          tokenType: tokenId ? 'erc721' : 'erc20',
          tokenName: tokenInfo.name,
          tokenSymbol: tokenInfo.symbol,
          fromAddress,
          toAddress,
          amount,
          tokenId
        };
      }

      return null;

    } catch (error) {
      logger.warn(`Failed to extract token transfer from log:`, error);
      return null;
    }
  }

  private async trackAccount(address: string, timestamp: number, isContract: boolean, accounts: any[]): Promise<void> {
    try {
      // Check if account already exists in our batch or database
      const existingInBatch = accounts.find(acc => acc.address === address);
      if (existingInBatch) return;

      const existingInDb = await this.clickhouseClient.getAccountInfo(address);
      if (existingInDb) return;

      // Get balance and nonce
      const [balance, nonce] = await Promise.all([
        this.rpcClient.getBalance(address),
        this.rpcClient.getTransactionCount(address)
      ]);

      const accountData = {
        address,
        balance,
        nonce,
        isContract,
        contractType: isContract ? 'contract' : 'eoa',
        firstSeen: new Date(timestamp * 1000),
        lastActivity: new Date(timestamp * 1000),
        transactionCount: nonce
      };

      accounts.push(accountData);

    } catch (error) {
      logger.warn(`Failed to track account ${address}:`, error);
    }
  }

  // =============================================
  // DATA INSERTION
  // =============================================

  private async batchInsertData(data: {
    blocks: BlockData[];
    transactions: TransactionData[];
    events: ContractEventData[];
    transfers: TokenTransfer[];
    accounts: any[];
    contracts: any[];
  }): Promise<void> {
    try {
      // Insert blocks
      if (data.blocks.length > 0) {
        await this.clickhouseClient.insertBlocks(data.blocks);
        logger.info(`📦 Inserted ${data.blocks.length} blocks`);
      }

      // Insert transactions
      if (data.transactions.length > 0) {
        await this.clickhouseClient.insertTransactions(data.transactions);
        logger.info(`💳 Inserted ${data.transactions.length} transactions`);
        this.stats.processedTransactions += data.transactions.length;
      }

      // Insert contract events
      if (data.events.length > 0) {
        await this.clickhouseClient.insertContractEvents(data.events);
        logger.info(`📋 Inserted ${data.events.length} contract events`);
      }

      // Insert token transfers
      if (data.transfers.length > 0) {
        await this.clickhouseClient.insertTokenTransfers(data.transfers);
        logger.info(`🪙 Inserted ${data.transfers.length} token transfers`);
      }

      // Insert accounts
      if (data.accounts.length > 0) {
        await this.clickhouseClient.insertAccounts(data.accounts);
        logger.info(`👤 Inserted ${data.accounts.length} new accounts`);
      }

      // Insert contracts (they're included in accounts)
      logger.info(`📝 Discovered ${data.contracts.length} new contracts`);

    } catch (error) {
      logger.error('❌ Error during batch data insertion:', error);
      throw error;
    }
  }

  // =============================================
  // CRON JOB & CONTINUOUS INDEXING
  // =============================================

  private setupCronJob(): void {
    // Disable cron job setup for now due to typing issues
    // TODO: Add proper node-cron types
    logger.info(`⏰ Cron job disabled - requires @types/node-cron`);
  }

  // =============================================
  // PUBLIC API
  // =============================================

  getStats(): IndexingStats {
    return { ...this.stats };
  }

  async forceSync(): Promise<void> {
    if (this.stats.isIndexing) {
      throw new Error('Indexing already in progress');
    }

    await this.syncToLatest(this.stats.latestBlock + 1);
  }

  async reindexBlock(blockNumber: number): Promise<void> {
    logger.info(`🔄 Re-indexing block ${blockNumber}`);
    await this.indexBlockRange(blockNumber, blockNumber);
  }

  async retryFailedBlocks(): Promise<void> {
    const failedBlocks = await this.clickhouseClient.getFailedBlocks();
    
    if (failedBlocks.length === 0) {
      logger.info('✅ No failed blocks to retry');
      return;
    }

    logger.info(`🔄 Retrying ${failedBlocks.length} failed blocks`);
    
    for (const blockNumber of failedBlocks) {
      try {
        await this.reindexBlock(blockNumber);
      } catch (error) {
        logger.error(`❌ Failed to retry block ${blockNumber}:`, error);
      }
    }
  }

  getRunningStatus(): boolean {
    return this.indexerRunning;
  }
}