// Monad Blockchain RPC Client
// Connects to Monad testnet and provides blockchain data access

import { ethers, JsonRpcProvider, Block, TransactionResponse, TransactionReceipt, Log } from 'ethers';
import { logger } from '../../utils/logger';

export interface MonadRpcConfig {
  rpcUrl: string;
  chainId?: number;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface BlockData {
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  timestamp: number;
  miner: string;
  gasLimit: bigint;
  gasUsed: bigint;
  baseFeePerGas?: bigint;
  size: number;
  transactionCount: number;
  transactions: string[];
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
  logsBloom: string;
  extraData: string;
  nonce?: string;
  difficulty?: bigint;
  totalDifficulty?: bigint;
}

export interface TransactionData {
  hash: string;
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;
  from: string;
  to?: string;
  value: bigint;
  gas: bigint;
  gasPrice: bigint;
  gasUsed?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce: number;
  data: string;
  type: number;
  status?: number;
  contractAddress?: string;
  createsContract: boolean;
}

export interface ContractEventData {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
  removed?: boolean;
}

export class MonadRpcClient {
  private provider: JsonRpcProvider;
  private config: MonadRpcConfig;
  private isConnected: boolean = false;

  constructor(config: MonadRpcConfig) {
    this.config = {
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      ...config
    };

    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl, {
      chainId: this.config.chainId || 10143, // Monad testnet
      name: 'monad-testnet'
    });

    // Set timeout
    if (this.config.timeout) {
      // Provider timeout configuration
    }
  }

  // =============================================
  // CONNECTION MANAGEMENT
  // =============================================

  async connect(): Promise<void> {
    try {
      logger.info('🔗 Connecting to Monad RPC...');
      
      // Test connection
      const network = await this.provider.getNetwork();
      logger.info(`✅ Connected to Monad network: ${network.name} (Chain ID: ${network.chainId})`);
      
      this.isConnected = true;
    } catch (error) {
      logger.error('❌ Failed to connect to Monad RPC:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.provider) {
      await this.provider.destroy();
      this.isConnected = false;
      logger.info('🔌 Disconnected from Monad RPC');
    }
  }

  isReady(): boolean {
    return this.isConnected;
  }

  // =============================================
  // BLOCK OPERATIONS
  // =============================================

  async getLatestBlockNumber(): Promise<number> {
    return await this.retryOperation(async () => {
      return await this.provider.getBlockNumber();
    });
  }

  async getBlock(blockNumber: number | string, includeTxs: boolean = false): Promise<BlockData | null> {
    return await this.retryOperation(async () => {
      const block = await this.provider.getBlock(blockNumber, includeTxs);
      if (!block) return null;

      return {
        blockNumber: block.number,
        blockHash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
        miner: block.miner || '0x0000000000000000000000000000000000000000',
        gasLimit: block.gasLimit,
        gasUsed: block.gasUsed,
        baseFeePerGas: block.baseFeePerGas || undefined,
        size: 0, // Will be calculated or fetched separately
        transactionCount: block.transactions.length,
        transactions: block.transactions as string[],
        stateRoot: block.stateRoot || '',
        transactionsRoot: block.hash, // Using block hash as fallback
        receiptsRoot: block.hash, // Using block hash as fallback  
        logsBloom: block.logsBloom || '0x',
        extraData: block.extraData || '0x',
        nonce: block.nonce || undefined,
        difficulty: block.difficulty || undefined,
        totalDifficulty: undefined // Not available in ethers v6
      };
    });
  }

  async getBlockRange(fromBlock: number, toBlock: number): Promise<BlockData[]> {
    const blocks: BlockData[] = [];
    
    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      try {
        const block = await this.getBlock(blockNum);
        if (block) {
          blocks.push(block);
        }
      } catch (error) {
        logger.warn(`Failed to fetch block ${blockNum}:`, error);
      }
    }
    
    return blocks;
  }

  // =============================================
  // TRANSACTION OPERATIONS
  // =============================================

  async getTransaction(txHash: string): Promise<TransactionData | null> {
    return await this.retryOperation(async () => {
      const [tx, receipt] = await Promise.all([
        this.provider.getTransaction(txHash),
        this.provider.getTransactionReceipt(txHash)
      ]);

      if (!tx) return null;

      return {
        hash: tx.hash,
        blockNumber: tx.blockNumber || 0,
        blockHash: tx.blockHash || '',
        transactionIndex: tx.index || 0,
        from: tx.from,
        to: tx.to || undefined,
        value: tx.value,
        gas: tx.gasLimit,
        gasPrice: tx.gasPrice || 0n,
        gasUsed: receipt?.gasUsed || undefined,
        maxFeePerGas: tx.maxFeePerGas || undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas || undefined,
        nonce: tx.nonce,
        data: tx.data,
        type: tx.type || 0,
        status: receipt?.status || undefined,
        contractAddress: receipt?.contractAddress || undefined,
        createsContract: !!receipt?.contractAddress
      };
    });
  }

  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
    return await this.retryOperation(async () => {
      return await this.provider.getTransactionReceipt(txHash);
    });
  }

  async getTransactionsFromBlock(blockNumber: number): Promise<TransactionData[]> {
    const block = await this.getBlock(blockNumber, true);
    if (!block) return [];

    const transactions: TransactionData[] = [];
    
    for (const txHash of block.transactions) {
      try {
        const tx = await this.getTransaction(txHash);
        if (tx) {
          transactions.push(tx);
        }
      } catch (error) {
        logger.warn(`Failed to fetch transaction ${txHash}:`, error);
      }
    }

    return transactions;
  }

  // =============================================
  // CONTRACT & LOGS OPERATIONS
  // =============================================

  async getContractCode(address: string, blockTag?: string | number): Promise<string> {
    return await this.retryOperation(async () => {
      return await this.provider.getCode(address, blockTag);
    });
  }

  async getBalance(address: string, blockTag?: string | number): Promise<bigint> {
    return await this.retryOperation(async () => {
      return await this.provider.getBalance(address, blockTag);
    });
  }

  async getTransactionCount(address: string, blockTag?: string | number): Promise<number> {
    return await this.retryOperation(async () => {
      return await this.provider.getTransactionCount(address, blockTag);
    });
  }

  async getLogs(filter: {
    fromBlock?: number | string;
    toBlock?: number | string;
    address?: string | string[];
    topics?: (string | string[] | null)[];
  }): Promise<ContractEventData[]> {
    return await this.retryOperation(async () => {
      const logs = await this.provider.getLogs(filter);
      
      return logs.map(log => ({
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        address: log.address,
        topics: log.topics,
        data: log.data,
        removed: log.removed
      }));
    });
  }

  // =============================================
  // TOKEN OPERATIONS
  // =============================================

  async isContract(address: string): Promise<boolean> {
    try {
      const code = await this.getContractCode(address);
      return code !== '0x';
    } catch (error) {
      logger.warn(`Failed to check if ${address} is contract:`, error);
      return false;
    }
  }

  // Standard ERC-20 function signatures
  private readonly ERC20_FUNCTIONS = {
    name: '0x06fdde03',
    symbol: '0x95d89b41', 
    decimals: '0x313ce567',
    totalSupply: '0x18160ddd'
  };

  async getTokenInfo(contractAddress: string): Promise<{
    name?: string;
    symbol?: string;
    decimals?: number;
    totalSupply?: bigint;
  }> {
    try {
      const contract = new ethers.Contract(contractAddress, [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)'
      ], this.provider);

      const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
        contract.name(),
        contract.symbol(),
        contract.decimals(),
        contract.totalSupply()
      ]);

      return {
        name: name.status === 'fulfilled' ? name.value : undefined,
        symbol: symbol.status === 'fulfilled' ? symbol.value : undefined,
        decimals: decimals.status === 'fulfilled' ? decimals.value : undefined,
        totalSupply: totalSupply.status === 'fulfilled' ? totalSupply.value : undefined
      };
    } catch (error) {
      logger.warn(`Failed to get token info for ${contractAddress}:`, error);
      return {};
    }
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  private async retryOperation<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= (this.config.retryAttempts || 3); attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        logger.warn(`RPC operation failed (attempt ${attempt}/${this.config.retryAttempts}):`, error);
        
        if (attempt < (this.config.retryAttempts || 3)) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay || 1000));
        }
      }
    }
    
    throw lastError;
  }

  async getCurrentGasPrice(): Promise<bigint> {
    return await this.retryOperation(async () => {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice || 0n;
    });
  }

  async getNetworkInfo(): Promise<{
    chainId: bigint;
    name: string;
    blockNumber: number;
    gasPrice: bigint;
  }> {
    const [network, blockNumber, gasPrice] = await Promise.all([
      this.provider.getNetwork(),
      this.getLatestBlockNumber(),
      this.getCurrentGasPrice()
    ]);

    return {
      chainId: network.chainId,
      name: network.name,
      blockNumber,
      gasPrice
    };
  }
}