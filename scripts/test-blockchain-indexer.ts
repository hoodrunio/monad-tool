// Test Monad Blockchain Indexer
// This script tests the blockchain indexing functionality

import 'dotenv/config';
import { BlockchainIndexer, IndexerConfig } from '../src/services/blockchain/BlockchainIndexer';
import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { MonadRedisClient } from '../src/cache/redis-client';
import { ServiceContainer } from '../src/services/service-container';
import { logger } from '../src/utils/logger';

async function testBlockchainIndexer() {
  console.log('🚀 Testing Monad Blockchain Indexer...');

  try {
    // =============================================
    // SETUP SERVICES
    // =============================================

    // Initialize service container
    const serviceContainer = ServiceContainer.getInstance({
      clickhouse: {
        host: process.env.CLICKHOUSE_HOST || 'localhost',
        port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
        username: process.env.CLICKHOUSE_USERNAME || 'default',
        password: process.env.CLICKHOUSE_PASSWORD || '',
        database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
        max_open_connections: 10,
        max_query_timeout: 30000,
        compression: true
      },
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: 0,
        keyPrefix: 'monad:',
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 1000,
        maxMemoryPolicy: 'allkeys-lru',
        defaultTtl: 300
      }
    });

    await serviceContainer.initialize();

    const clickhouseClient = serviceContainer.getClickHouseClient();
    const redisClient = serviceContainer.getRedisClient();

    // =============================================
    // CONFIGURE BLOCKCHAIN INDEXER
    // =============================================

    const indexerConfig: IndexerConfig = {
      rpc: {
        rpcUrl: process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz',
        chainId: 10143, // Monad testnet
        timeout: 30000,
        retryAttempts: 3,
        retryDelay: 1000
      },
      indexing: {
        startBlock: parseInt(process.env.START_BLOCK || '1'), // Start from block 1
        batchSize: 5, // Small batch for testing
        concurrentRequests: 2,
        retryAttempts: 3,
        blockConfirmations: 3, // Wait for 3 confirmations
        enableContractDetection: true,
        enableTokenTracking: true,
        enableNftMetadata: true
      },
      cron: {
        enabled: false, // Disable cron for testing
        schedule: '*/30 * * * * *' // Every 30 seconds
      }
    };

    // =============================================
    // CREATE AND START INDEXER
    // =============================================

    const indexer = new BlockchainIndexer(indexerConfig, clickhouseClient, redisClient);

    // Setup event listeners
    indexer.on('started', () => {
      console.log('✅ Blockchain Indexer started');
    });

    indexer.on('progress', (data) => {
      console.log(`📊 Progress: ${data.processedBlocks} blocks processed, current: ${data.currentBlock}`);
    });

    indexer.on('error', (error) => {
      console.error('❌ Indexer error:', error);
    });

    // Start indexing
    console.log('🔄 Starting blockchain indexer...');
    await indexer.start();

    // =============================================
    // MANUAL TESTING
    // =============================================

    console.log('\n📋 Testing manual block indexing...');
    
    // Test indexing a range of blocks
    const startBlock = 100;
    const endBlock = 105;
    
    console.log(`🔍 Indexing blocks ${startBlock} to ${endBlock}...`);
    await indexer.indexBlockRange(startBlock, endBlock);

    // Get stats
    const stats = indexer.getStats();
    console.log('\n📈 Indexing Stats:');
    console.log(`- Latest Block: ${stats.latestBlock}`);
    console.log(`- Processed Blocks: ${stats.processedBlocks}`);
    console.log(`- Processed Transactions: ${stats.processedTransactions}`);
    console.log(`- Discovered Contracts: ${stats.discoveredContracts}`);
    console.log(`- Discovered Tokens: ${stats.discoveredTokens}`);
    console.log(`- Indexing Rate: ${stats.indexingRate.toFixed(2)} blocks/min`);
    console.log(`- Is Indexing: ${stats.isIndexing}`);

    // =============================================
    // DATABASE VERIFICATION
    // =============================================

    console.log('\n🔍 Verifying database content...');

    // Check blocks table
    const blockQuery = 'SELECT COUNT(*) as count FROM blocks';
    const blockResult = await clickhouseClient.executeRawQuery(blockQuery);
    console.log(`📦 Total blocks in database: ${blockResult[0]?.count || 0}`);

    // Check transactions table
    const txQuery = 'SELECT COUNT(*) as count FROM transactions';
    const txResult = await clickhouseClient.executeRawQuery(txQuery);
    console.log(`💳 Total transactions in database: ${txResult[0]?.count || 0}`);

    // Check accounts table
    const accountQuery = 'SELECT COUNT(*) as count FROM accounts';
    const accountResult = await clickhouseClient.executeRawQuery(accountQuery);
    console.log(`👤 Total accounts in database: ${accountResult[0]?.count || 0}`);

    // Check contract events table
    const eventQuery = 'SELECT COUNT(*) as count FROM contract_events';
    const eventResult = await clickhouseClient.executeRawQuery(eventQuery);
    console.log(`📋 Total contract events in database: ${eventResult[0]?.count || 0}`);

    // Check token transfers table
    const transferQuery = 'SELECT COUNT(*) as count FROM token_transfers';
    const transferResult = await clickhouseClient.executeRawQuery(transferQuery);
    console.log(`🪙 Total token transfers in database: ${transferResult[0]?.count || 0}`);

    // =============================================
    // SAMPLE DATA QUERIES
    // =============================================

    console.log('\n📊 Sample database queries...');

    // Get latest blocks
    const latestBlocksQuery = `
      SELECT block_number, block_hash, timestamp, miner, transaction_count
      FROM blocks
      ORDER BY block_number DESC
      LIMIT 5
    `;
    const latestBlocks = await clickhouseClient.executeRawQuery(latestBlocksQuery);
    console.log('\n🔸 Latest blocks:');
    latestBlocks.forEach((block: any, i: number) => {
      console.log(`  ${i + 1}. Block ${block.block_number} - ${block.transaction_count} txs - ${block.timestamp}`);
    });

    // Get latest transactions
    const latestTxQuery = `
      SELECT transaction_hash, block_number, from_address, to_address, value
      FROM transactions
      ORDER BY block_number DESC, transaction_index DESC
      LIMIT 5
    `;
    const latestTxs = await clickhouseClient.executeRawQuery(latestTxQuery);
    console.log('\n🔸 Latest transactions:');
    latestTxs.forEach((tx: any, i: number) => {
      console.log(`  ${i + 1}. ${tx.transaction_hash.slice(0, 10)}... Block ${tx.block_number} - ${tx.value} MON`);
    });

    // =============================================
    // API TEST (if enabled)
    // =============================================

    if (process.env.TEST_API === 'true') {
      console.log('\n🌐 Testing API endpoints...');

      const { createBlockchainRoutes } = await import('../src/api/routes/blockchain');
      const express = require('express');
      
      const app = express();
      app.use('/api/blockchain', createBlockchainRoutes(clickhouseClient, redisClient));

      const server = app.listen(3001, () => {
        console.log('🌐 Test API server running on port 3001');
      });

      // Test API endpoints
      const axios = require('axios');
      const baseUrl = 'http://localhost:3001/api/blockchain';

      try {
        console.log('🔍 Testing /blocks endpoint...');
        const blocksResponse = await axios.get(`${baseUrl}/blocks?limit=5`);
        console.log(`✅ Blocks API: ${blocksResponse.data.blocks.length} blocks returned`);

        console.log('🔍 Testing /transactions endpoint...');
        const txResponse = await axios.get(`${baseUrl}/transactions?limit=5`);
        console.log(`✅ Transactions API: ${txResponse.data.transactions.length} transactions returned`);

        console.log('🔍 Testing /stats endpoint...');
        const statsResponse = await axios.get(`${baseUrl}/stats`);
        console.log(`✅ Stats API: ${JSON.stringify(statsResponse.data, null, 2)}`);

      } catch (apiError) {
        console.error('❌ API test error:', apiError);
      }

      server.close();
    }

    // =============================================
    // CLEANUP
    // =============================================

    console.log('\n🧹 Stopping indexer...');
    await indexer.stop();

    console.log('\n✅ Blockchain indexer test completed successfully!');

    console.log('\n🎯 Next Steps:');
    console.log('1. Run with larger block ranges to index more data');
    console.log('2. Enable cron job for continuous indexing');
    console.log('3. Set up API server for blockchain explorer frontend');
    console.log('4. Configure NFT metadata fetching');
    console.log('5. Add monitoring and alerting');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Environment variable examples
console.log('\n📝 Environment Variables Example:');
console.log('MONAD_RPC_URL=https://testnet-rpc.monad.xyz');
console.log('START_BLOCK=1');
console.log('TEST_API=true');
console.log('CLICKHOUSE_HOST=localhost');
console.log('REDIS_HOST=localhost');

// Run the test
if (require.main === module) {
  testBlockchainIndexer().catch(console.error);
}