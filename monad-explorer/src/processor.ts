import {assertNotNull} from '@subsquid/util-internal'
import {
    BlockHeader,
    DataHandlerContext,
    EvmBatchProcessor,
    EvmBatchProcessorFields,
    Log as _Log,
    Transaction as _Transaction,
} from '@subsquid/evm-processor'
import { appConfig } from './config/AppConfig'

const config = appConfig.getConfig();

const startBlock = config.processor.startBlock;

export const processor = new EvmBatchProcessor()
    // Remove archive for Monad - use RPC-only mode
    // .setGateway() // Comment out archive gateway
    // Configure for Monad testnet RPC-only
    .setRpcEndpoint({
        // Monad testnet RPC with optimized settings
        url: assertNotNull(process.env.RPC_MONAD_HTTP || 'https://testnet-rpc.monad.xyz', 'No RPC endpoint supplied'),
        rateLimit: 50, // req/sec
        capacity: 100, // capacity for burst requests
        requestTimeout: 30000, // 30 second timeout
        maxBatchCallSize: 100 // batch call size
    })
    .setFinalityConfirmation(2)
    .setFields({
        transaction: {
            // Basic fields
            from: true,
            to: true,
            value: true,
            hash: true,
            gas: true,
            gasPrice: true,
            gasUsed: true,
            status: true,
            input: true,
            // Enhanced fields for comprehensive transaction data
            nonce: true,
            type: true,
            maxFeePerGas: true,
            maxPriorityFeePerGas: true,
            // effectiveGasPrice will be calculated
            cumulativeGasUsed: true,
        },
        block: {
            // Basic fields
            number: true,
            hash: true,
            parentHash: true,
            timestamp: true,
            size: true,
            gasLimit: true,
            gasUsed: true,
            extraData: true,
            baseFeePerGas: true,
            miner: true,
        },
        log: {
            address: true,
            topics: true,
            data: true,
            transactionHash: true,
            logIndex: true,
            removed: true,
        }
    })
    .setBlockRange({
        // Start from recent blocks (latest - 1000) for faster testing
        from: startBlock, // Recent Monad testnet blocks
    })
    // Index all transactions for RPC-only mode
    .addTransaction({
        range: {from: startBlock}
    })
    // Index all logs for event processing
    .addLog({
        range: {from: startBlock}
    })

export type Fields = EvmBatchProcessorFields<typeof processor>
export type Block = BlockHeader<Fields>
export type Log = _Log<Fields>
export type Transaction = _Transaction<Fields>
export type ProcessorContext<Store> = DataHandlerContext<Store, Fields>
