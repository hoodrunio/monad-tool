import {assertNotNull} from '@subsquid/util-internal'
import {
    BlockHeader,
    DataHandlerContext,
    EvmBatchProcessor,
    EvmBatchProcessorFields,
    Log as _Log,
    Transaction as _Transaction,
} from '@subsquid/evm-processor'

export const processor = new EvmBatchProcessor()
    // Remove archive for Monad - use RPC-only mode
    // .setGateway() // Comment out archive gateway
    // Configure for Monad testnet RPC-only
    .setRpcEndpoint({
        // Monad testnet RPC
        url: assertNotNull(process.env.RPC_MONAD_HTTP || 'https://testnet-rpc.monad.xyz', 'No RPC endpoint supplied'),
        rateLimit: 10
    })
    .setFinalityConfirmation(75)
    .setFields({
        transaction: {
            from: true,
            to: true,
            value: true,
            hash: true,
            gas: true,
            gasPrice: true,
            gasUsed: true,
            status: true,
            input: true,
        },
        block: {
            number: true,
            hash: true,
            parentHash: true,
            timestamp: true,
            size: true,
            gasLimit: true,
            gasUsed: true,
        },
        log: {
            address: true,
            topics: true,
            data: true,
            transactionHash: true,
        }
    })
    .setBlockRange({
        // Start from recent blocks (latest - 1000) for faster testing
        from: 23183000, // Recent Monad testnet blocks
    })
    // Index all transactions for RPC-only mode
    .addTransaction({
        range: {from: 23183000}
    })
    // Index all logs for event processing
    .addLog({
        range: {from: 23183000}
    })

export type Fields = EvmBatchProcessorFields<typeof processor>
export type Block = BlockHeader<Fields>
export type Log = _Log<Fields>
export type Transaction = _Transaction<Fields>
export type ProcessorContext<Store> = DataHandlerContext<Store, Fields>
