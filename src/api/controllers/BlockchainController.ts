// Blockchain Explorer API Controller
// Provides REST API endpoints for blockchain data

import { Request, Response } from 'express';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { logger } from '../../utils/logger';

export class BlockchainController {
  constructor(
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {}

  // =============================================
  // BLOCKS API
  // =============================================

  async getLatestBlocks(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const cacheKey = `latest_blocks:${limit}:${offset}`;
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const query = `
        SELECT 
          block_number,
          block_hash,
          timestamp,
          miner,
          gas_used,
          gas_limit,
          transaction_count,
          size
        FROM blocks
        ORDER BY block_number DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const blocks = await this.clickhouseClient.executeRawQuery(query);

      const result = {
        blocks: blocks.map((block: any) => ({
          blockNumber: parseInt(block.block_number),
          blockHash: block.block_hash,
          timestamp: block.timestamp,
          miner: block.miner,
          gasUsed: block.gas_used,
          gasLimit: block.gas_limit,
          transactionCount: parseInt(block.transaction_count),
          size: parseInt(block.size)
        })),
        pagination: {
          limit,
          offset,
          total: blocks.length
        }
      };

      await this.redisClient.setex(cacheKey, 30, JSON.stringify(result)); // Cache for 30 seconds

      res.json(result);
    } catch (error) {
      logger.error('Error fetching latest blocks:', error);
      res.status(500).json({ error: 'Failed to fetch blocks' });
    }
  }

  async getBlockByNumber(req: Request, res: Response): Promise<void> {
    try {
      const blockNumber = parseInt(req.params.blockNumber);
      if (isNaN(blockNumber)) {
        res.status(400).json({ error: 'Invalid block number' });
        return;
      }

      const cacheKey = `block:${blockNumber}`;
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const query = `
        SELECT *
        FROM blocks
        WHERE block_number = ${blockNumber}
        LIMIT 1
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);
      const block = result[0];

      if (!block) {
        res.status(404).json({ error: 'Block not found' });
        return;
      }

      const blockData = {
        blockNumber: parseInt(block.block_number),
        blockHash: block.block_hash,
        parentHash: block.parent_hash,
        timestamp: block.timestamp,
        miner: block.miner,
        gasUsed: block.gas_used,
        gasLimit: block.gas_limit,
        baseFeePerGas: block.base_fee_per_gas,
        transactionCount: parseInt(block.transaction_count),
        size: parseInt(block.size),
        stateRoot: block.state_root,
        transactionsRoot: block.transactions_root,
        receiptsRoot: block.receipts_root,
        extraData: block.extra_data
      };

      await this.redisClient.setex(cacheKey, 300, JSON.stringify(blockData)); // Cache for 5 minutes

      res.json(blockData);
    } catch (error) {
      logger.error('Error fetching block:', error);
      res.status(500).json({ error: 'Failed to fetch block' });
    }
  }

  // =============================================
  // TRANSACTIONS API
  // =============================================

  async getLatestTransactions(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const cacheKey = `latest_transactions:${limit}:${offset}`;
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const query = `
        SELECT 
          transaction_hash,
          block_number,
          timestamp,
          from_address,
          to_address,
          value,
          gas,
          gas_price,
          gas_used,
          status,
          creates_contract,
          contract_address
        FROM transactions
        ORDER BY block_number DESC, transaction_index DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const transactions = await this.clickhouseClient.executeRawQuery(query);

      const result = {
        transactions: transactions.map((tx: any) => ({
          hash: tx.transaction_hash,
          blockNumber: parseInt(tx.block_number),
          timestamp: tx.timestamp,
          from: tx.from_address,
          to: tx.to_address,
          value: tx.value,
          gas: tx.gas,
          gasPrice: tx.gas_price,
          gasUsed: tx.gas_used,
          status: tx.status,
          createsContract: tx.creates_contract === 1,
          contractAddress: tx.contract_address
        })),
        pagination: {
          limit,
          offset,
          total: transactions.length
        }
      };

      await this.redisClient.setex(cacheKey, 30, JSON.stringify(result));

      res.json(result);
    } catch (error) {
      logger.error('Error fetching latest transactions:', error);
      res.status(500).json({ error: 'Failed to fetch transactions' });
    }
  }

  async getTransactionByHash(req: Request, res: Response): Promise<void> {
    try {
      const txHash = req.params.hash;
      if (!txHash.startsWith('0x') || txHash.length !== 66) {
        res.status(400).json({ error: 'Invalid transaction hash' });
        return;
      }

      const cacheKey = `transaction:${txHash}`;
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const query = `
        SELECT *
        FROM transactions
        WHERE transaction_hash = '${txHash}'
        LIMIT 1
      `;

      const result = await this.clickhouseClient.executeRawQuery(query);
      const tx = result[0];

      if (!tx) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      const transactionData = {
        hash: tx.transaction_hash,
        blockNumber: parseInt(tx.block_number),
        blockHash: tx.block_hash,
        transactionIndex: parseInt(tx.transaction_index),
        timestamp: tx.timestamp,
        from: tx.from_address,
        to: tx.to_address,
        value: tx.value,
        gas: tx.gas,
        gasPrice: tx.gas_price,
        gasUsed: tx.gas_used,
        maxFeePerGas: tx.max_fee_per_gas,
        maxPriorityFeePerGas: tx.max_priority_fee_per_gas,
        nonce: parseInt(tx.nonce),
        input: tx.input,
        status: tx.status,
        transactionType: tx.transaction_type,
        createsContract: tx.creates_contract === 1,
        contractAddress: tx.contract_address
      };

      await this.redisClient.setex(cacheKey, 300, JSON.stringify(transactionData));

      res.json(transactionData);
    } catch (error) {
      logger.error('Error fetching transaction:', error);
      res.status(500).json({ error: 'Failed to fetch transaction' });
    }
  }

  // =============================================
  // ACCOUNTS API
  // =============================================

  async getAccountInfo(req: Request, res: Response): Promise<void> {
    try {
      const address = req.params.address;
      if (!address.startsWith('0x') || address.length !== 42) {
        res.status(400).json({ error: 'Invalid address format' });
        return;
      }

      const cacheKey = `account:${address}`;
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const account = await this.clickhouseClient.getAccountInfo(address);
      
      if (!account) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }

      const accountData = {
        address: account.address,
        balance: account.balance,
        nonce: parseInt(account.nonce),
        isContract: account.is_contract === 1,
        contractType: account.contract_type,
        transactionCount: parseInt(account.transaction_count),
        firstSeen: account.first_seen,
        lastActivity: account.last_activity,
        tokenInfo: account.token_name ? {
          name: account.token_name,
          symbol: account.token_symbol,
          decimals: account.token_decimals,
          totalSupply: account.token_total_supply
        } : null
      };

      await this.redisClient.setex(cacheKey, 120, JSON.stringify(accountData)); // Cache for 2 minutes

      res.json(accountData);
    } catch (error) {
      logger.error('Error fetching account info:', error);
      res.status(500).json({ error: 'Failed to fetch account info' });
    }
  }

  async getAccountTransactions(req: Request, res: Response): Promise<void> {
    try {
      const address = req.params.address;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const transactions = await this.clickhouseClient.getTransactionsByAddress(address, limit, offset);

      const result = {
        transactions: transactions.map((tx: any) => ({
          hash: tx.transaction_hash,
          blockNumber: parseInt(tx.block_number),
          timestamp: tx.timestamp,
          from: tx.from_address,
          to: tx.to_address,
          value: tx.value,
          gasUsed: tx.gas_used,
          status: tx.status
        })),
        pagination: {
          limit,
          offset,
          total: transactions.length
        }
      };

      res.json(result);
    } catch (error) {
      logger.error('Error fetching account transactions:', error);
      res.status(500).json({ error: 'Failed to fetch account transactions' });
    }
  }

  // =============================================
  // TOKENS API
  // =============================================

  async getTopTokens(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

      const cacheKey = `top_tokens:${limit}`;
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const tokens = await this.clickhouseClient.getTopTokens(limit);

      const result = {
        tokens: tokens.map((token: any) => ({
          address: token.token_address,
          name: token.token_name,
          symbol: token.token_symbol,
          type: token.token_type,
          transferCount: parseInt(token.transfer_count),
          uniqueSenders: parseInt(token.unique_senders),
          uniqueReceivers: parseInt(token.unique_receivers)
        }))
      };

      await this.redisClient.setex(cacheKey, 300, JSON.stringify(result)); // Cache for 5 minutes

      res.json(result);
    } catch (error) {
      logger.error('Error fetching top tokens:', error);
      res.status(500).json({ error: 'Failed to fetch top tokens' });
    }
  }

  async getTokenTransfers(req: Request, res: Response): Promise<void> {
    try {
      const tokenAddress = req.params.address;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

      const query = `
        SELECT 
          transaction_hash,
          block_number,
          timestamp,
          from_address,
          to_address,
          amount,
          token_id
        FROM token_transfers
        WHERE token_address = '${tokenAddress}'
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;

      const transfers = await this.clickhouseClient.executeRawQuery(query);

      const result = {
        transfers: transfers.map((transfer: any) => ({
          transactionHash: transfer.transaction_hash,
          blockNumber: parseInt(transfer.block_number),
          timestamp: transfer.timestamp,
          from: transfer.from_address,
          to: transfer.to_address,
          amount: transfer.amount,
          tokenId: transfer.token_id
        }))
      };

      res.json(result);
    } catch (error) {
      logger.error('Error fetching token transfers:', error);
      res.status(500).json({ error: 'Failed to fetch token transfers' });
    }
  }

  // =============================================
  // STATS API
  // =============================================

  async getNetworkStats(req: Request, res: Response): Promise<void> {
    try {
      const cacheKey = 'network_stats';
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const stats = await this.clickhouseClient.getNetworkStats();

      const result = {
        totalBlocks: parseInt(stats.total_blocks) || 0,
        uniqueMiners: parseInt(stats.unique_miners) || 0,
        avgGasUtilization: parseFloat(stats.avg_gas_utilization) || 0,
        totalTransactions: parseInt(stats.total_transactions) || 0,
        timestamp: new Date()
      };

      await this.redisClient.setex(cacheKey, 60, JSON.stringify(result)); // Cache for 1 minute

      res.json(result);
    } catch (error) {
      logger.error('Error fetching network stats:', error);
      res.status(500).json({ error: 'Failed to fetch network stats' });
    }
  }

  // =============================================
  // SEARCH API
  // =============================================

  async search(req: Request, res: Response): Promise<void> {
    try {
      const query = req.query.q as string;
      if (!query) {
        res.status(400).json({ error: 'Search query required' });
        return;
      }

      const results: any = {
        blocks: [],
        transactions: [],
        accounts: []
      };

      // Search by block number
      if (/^\d+$/.test(query)) {
        const blockNumber = parseInt(query);
        const blockQuery = `
          SELECT block_number, block_hash, timestamp
          FROM blocks
          WHERE block_number = ${blockNumber}
          LIMIT 1
        `;
        const blocks = await this.clickhouseClient.executeRawQuery(blockQuery);
        results.blocks = blocks.map((block: any) => ({
          blockNumber: parseInt(block.block_number),
          blockHash: block.block_hash,
          timestamp: block.timestamp
        }));
      }

      // Search by hash (transaction or block)
      if (query.startsWith('0x') && query.length === 66) {
        // Transaction hash
        const txQuery = `
          SELECT transaction_hash, block_number, timestamp
          FROM transactions
          WHERE transaction_hash = '${query}'
          LIMIT 1
        `;
        const transactions = await this.clickhouseClient.executeRawQuery(txQuery);
        results.transactions = transactions.map((tx: any) => ({
          hash: tx.transaction_hash,
          blockNumber: parseInt(tx.block_number),
          timestamp: tx.timestamp
        }));

        // Block hash
        const blockQuery = `
          SELECT block_number, block_hash, timestamp
          FROM blocks
          WHERE block_hash = '${query}'
          LIMIT 1
        `;
        const blocks = await this.clickhouseClient.executeRawQuery(blockQuery);
        results.blocks.push(...blocks.map((block: any) => ({
          blockNumber: parseInt(block.block_number),
          blockHash: block.block_hash,
          timestamp: block.timestamp
        })));
      }

      // Search by address
      if (query.startsWith('0x') && query.length === 42) {
        const accountQuery = `
          SELECT address, is_contract, last_activity
          FROM accounts
          WHERE address = '${query}'
          LIMIT 1
        `;
        const accounts = await this.clickhouseClient.executeRawQuery(accountQuery);
        results.accounts = accounts.map((account: any) => ({
          address: account.address,
          isContract: account.is_contract === 1,
          lastActivity: account.last_activity
        }));
      }

      res.json(results);
    } catch (error) {
      logger.error('Error performing search:', error);
      res.status(500).json({ error: 'Search failed' });
    }
  }
}