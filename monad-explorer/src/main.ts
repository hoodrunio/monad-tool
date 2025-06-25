import {TypeormDatabase} from '@subsquid/typeorm-store'
import {Block, Transaction, Account, Log, Token, TokenTransfer, MethodSignature} from './model'
import {processor} from './processor'
import { 
    BlockProcessor, 
    TransactionProcessor, 
    AccountProcessor, 
    LogProcessor, 
    TokenTransferProcessor 
} from './processors'

/**
 * Main processor following SOLID principles
 * Following Single Responsibility Principle - only coordinates processing
 * Following Dependency Inversion Principle - depends on processor abstractions
 */
processor.run(new TypeormDatabase({supportHotBlocks: true}), async (ctx) => {
    // Initialize processors (following Dependency Injection pattern)
    const blockProcessor = new BlockProcessor()
    const transactionProcessor = new TransactionProcessor()
    const accountProcessor = new AccountProcessor()
    const logProcessor = new LogProcessor()
    const tokenTransferProcessor = new TokenTransferProcessor()

    // Collect entities for batch processing
    const blocks: Block[] = []
    const transactions: Transaction[] = []
    const logs: Log[] = []
    const tokenTransfers: TokenTransfer[] = []
    const methodSignatures: Map<string, MethodSignature> = new Map()

    // Process each block using SOLID processors
    for (let c of ctx.blocks) {
        // Process Block (Single Responsibility)
        const block = blockProcessor.processBlock(c.header)
        blocks.push(block)

        // Process Transactions for this block
        for (let tx of c.transactions) {
            // Process Transaction (Single Responsibility)
            const transaction = transactionProcessor.processTransaction(tx, block)
            transactions.push(transaction)

            // Process Method Signature if available
            if (transaction.methodID) {
                const methodSignature = transactionProcessor.createMethodSignature(transaction.methodID)
                if (methodSignature && !methodSignatures.has(transaction.methodID)) {
                    methodSignatures.set(transaction.methodID, methodSignature)
                }
            }

            // Process Accounts (Single Responsibility)
            const isContractCreation = transaction.isContractCreation
            const isContractInteraction = transaction.isContractInteraction
            
            accountProcessor.processAccount(transaction.fromAddress, transaction.timestamp, false)
            if (transaction.toAddress) {
                const isContract = isContractInteraction || isContractCreation
                accountProcessor.processAccount(transaction.toAddress, transaction.timestamp, isContract)
            }

            // Process Logs (Single Responsibility)
            const transactionLogs = logProcessor.processLogs(tx.logs || [], transaction)
            logs.push(...transactionLogs)

            // Process Token Transfers (Single Responsibility)
            for (const [index, log] of (tx.logs || []).entries()) {
                if (logProcessor.isTokenTransfer(log)) {
                    const logEntity = transactionLogs[index]
                    const tokenTransfer = tokenTransferProcessor.processTokenTransfer(log, transaction, logEntity)
                    tokenTransfers.push(tokenTransfer)
                }
            }
        }

        // Update block transaction count after processing all transactions
        blockProcessor.updateTransactionCount(block, c.transactions.length)
    }

    // Get processed entities from processors
    const accounts = accountProcessor.getProcessedAccounts()
    const tokens = tokenTransferProcessor.getProcessedTokens()

    // Batch save all entities (optimized database operations)
    await ctx.store.upsert(accounts)
    await ctx.store.upsert([...methodSignatures.values()])
    await ctx.store.insert(blocks)
    await ctx.store.insert(transactions)
    await ctx.store.insert(logs)
    await ctx.store.upsert(tokens)
    await ctx.store.insert(tokenTransfers)

    // Log processing summary
    const startBlock = ctx.blocks.at(0)?.header.height
    const endBlock = ctx.blocks.at(-1)?.header.height
    ctx.log.info(`Processed blocks ${startBlock} to ${endBlock}: ${blocks.length} blocks, ${transactions.length} transactions, ${accounts.length} accounts`)

    // Clear processor caches for next batch (memory management)
    accountProcessor.clear()
    tokenTransferProcessor.clear()
})
