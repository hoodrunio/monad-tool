import { TypeormDatabase } from '@subsquid/typeorm-store';
import { processor } from './processor';
import { BlockProcessor, BlockProcessorConfig } from './services/processors/BlockProcessor';
import { logger } from './utils/logger';

// Enhanced token processing configuration
const PROCESSING_CONFIG: BlockProcessorConfig = {
  enableTokenEnrichment: process.env.ENABLE_TOKEN_ENRICHMENT === 'true',
  enableAsyncProcessing: process.env.ENABLE_ASYNC_PROCESSING === 'true',
  rpcUrl: process.env.RPC_MONAD_HTTP || 'https://testnet-rpc.monad.xyz',
};

// Initialize the block processor with SOLID architecture
const blockProcessor = new BlockProcessor(PROCESSING_CONFIG);

processor.run(new TypeormDatabase({ supportHotBlocks: true }), async (ctx) => {
  try {
    logger.info('Starting block processing batch', {
      blockRange: `${ctx.blocks.at(0)?.header.height} to ${ctx.blocks.at(-1)?.header.height}`,
      blockCount: ctx.blocks.length,
      config: PROCESSING_CONFIG
    });

    // Process all blocks using the SOLID architecture
    const results = await blockProcessor.processBlocks(ctx.store, ctx.blocks);

    // Save all entities in optimized batches
    await ctx.store.upsert(results.accounts);
    await ctx.store.upsert(results.methodSignatures);
    await ctx.store.insert(results.blocks);
    await ctx.store.insert(results.transactions);
    await ctx.store.insert(results.logs);

    // Save tokens first (if any were created during enhanced processing)
    // This would be handled by the enhanced processor integration

    // Insert token transfers
    if (results.tokenTransfers.length > 0) {
      await ctx.store.insert(results.tokenTransfers);
    }

    // Log processing summary with detailed statistics
    const startBlock = ctx.blocks.at(0)?.header.height;
    const endBlock = ctx.blocks.at(-1)?.header.height;
    
    logger.info('Block processing batch completed successfully', {
      blockRange: `${startBlock} to ${endBlock}`,
      statistics: {
        blocks: results.blocks.length,
        transactions: results.transactions.length,
        accounts: results.accounts.length,
        logs: results.logs.length,
        tokenTransfers: results.tokenTransfers.length,
        methodSignatures: results.methodSignatures.length
      },
      processorStats: blockProcessor.getStats()
    });

  } catch (error) {
    logger.error('Block processing batch failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      blockRange: `${ctx.blocks.at(0)?.header.height} to ${ctx.blocks.at(-1)?.header.height}`
    });
    throw error;
  }
});

// Graceful shutdown handling
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Log startup information
logger.info('Monad Explorer started with SOLID architecture', {
  config: PROCESSING_CONFIG,
  nodeEnv: process.env.NODE_ENV,
  pid: process.pid
}); 