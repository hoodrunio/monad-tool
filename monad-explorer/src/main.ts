import {TypeormDatabase} from '@subsquid/typeorm-store'
import {Block, Transaction, Account, Log, Contract, TokenTransfer, Token, DailyStats, TokenType} from './model'
import {processor} from './processor'

// Common token signatures
const ERC20_TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ERC721_TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

processor.run(new TypeormDatabase({supportHotBlocks: true}), async (ctx) => {
    const blocks: Block[] = []
    const transactions: Transaction[] = []
    const accounts: Map<string, Account> = new Map()
    const logs: Log[] = []
    const contracts: Contract[] = []
    const tokens: Map<string, Token> = new Map()
    const tokenTransfers: TokenTransfer[] = []

    for (let c of ctx.blocks) {
        // Process Block
        const block = new Block({
            id: c.header.hash,
            number: c.header.height,
            hash: c.header.hash,
            parentHash: c.header.parentHash,
            timestamp: new Date(c.header.timestamp),
            size: BigInt(c.header.size || 0),
            gasLimit: BigInt(c.header.gasLimit || 0),
            gasUsed: BigInt(c.header.gasUsed || 0),
            transactionCount: c.transactions.length,
        })
        blocks.push(block)

        // Process Transactions
        for (let tx of c.transactions) {
            const transaction = new Transaction({
                id: tx.hash,
                hash: tx.hash,
                block: block,
                transactionIndex: tx.transactionIndex,
                fromAddress: tx.from,
                toAddress: tx.to,
                value: tx.value,
                gas: BigInt(tx.gas || 0),
                gasPrice: BigInt(tx.gasPrice || 0),
                gasUsed: BigInt(tx.gasUsed || 0),
                input: tx.input,
                status: tx.status,
                timestamp: block.timestamp,
            })
            transactions.push(transaction)

            // Update or create sender account
            if (!accounts.has(tx.from)) {
                accounts.set(tx.from, new Account({
                    id: tx.from,
                    address: tx.from,
                    balance: 0n,
                    transactionCount: 0,
                    isContract: false,
                    createdAt: block.timestamp,
                }))
            }
            const fromAccount = accounts.get(tx.from)!
            fromAccount.transactionCount++

            // Update or create receiver account (if exists)
            if (tx.to) {
                if (!accounts.has(tx.to)) {
                    accounts.set(tx.to, new Account({
                        id: tx.to,
                        address: tx.to,
                        balance: 0n,
                        transactionCount: 0,
                        isContract: Boolean(tx.input && tx.input.length > 2), // Has input data = likely contract
                        createdAt: block.timestamp,
                    }))
                }

                // If this is a contract creation (no 'to' address)
                if (!tx.to && tx.input && tx.input.length > 2) {
                    // This would be a contract creation - we'd need to get the contract address
                    // For now, we'll handle this in a future update
                }
            }

            // Process Logs
            for (let log of tx.logs || []) {
                const logEntity = new Log({
                    id: `${tx.hash}-${log.logIndex}`,
                    transaction: transaction,
                    logIndex: log.logIndex,
                    address: log.address,
                    topics: log.topics,
                    data: log.data,
                })
                logs.push(logEntity)

                // Check if this is a token transfer event
                if (log.topics[0] === ERC20_TRANSFER_SIGNATURE && log.topics.length >= 3) {
                    await processTokenTransfer(log, transaction, logEntity, tokens, tokenTransfers)
                }
            }
        }
    }

    // Save all entities in batches for optimal performance
    await ctx.store.upsert([...accounts.values()])
    await ctx.store.insert(blocks)
    await ctx.store.insert(transactions)
    await ctx.store.insert(logs)
    await ctx.store.upsert([...tokens.values()])
    await ctx.store.insert(tokenTransfers)

    // Log processing summary
    const startBlock = ctx.blocks.at(0)?.header.height
    const endBlock = ctx.blocks.at(-1)?.header.height
    ctx.log.info(`Processed blocks ${startBlock} to ${endBlock}: ${blocks.length} blocks, ${transactions.length} transactions, ${accounts.size} accounts`)
})

async function processTokenTransfer(
    log: any,
    transaction: Transaction,
    logEntity: Log,
    tokens: Map<string, Token>,
    tokenTransfers: TokenTransfer[]
) {
    const tokenAddress = log.address
    const fromAddress = '0x' + log.topics[1].slice(26) // Remove padding
    const toAddress = '0x' + log.topics[2].slice(26) // Remove padding
    
    // Parse transfer value from data
    let value: bigint
    try {
        value = BigInt(log.data || '0x0')
    } catch {
        value = 0n
    }

    // Create or get token
    if (!tokens.has(tokenAddress)) {
        tokens.set(tokenAddress, new Token({
            id: tokenAddress,
            address: tokenAddress,
            name: `Token ${tokenAddress.slice(0, 8)}...`, // We'll fetch real name later
            symbol: 'UNKNOWN',
            decimals: 18, // Default, we'll fetch real decimals later
            totalSupply: 0n,
            tokenType: TokenType.ERC20, // Assume ERC20 for now
            createdAt: transaction.timestamp,
        }))
    }

    const token = tokens.get(tokenAddress)!

    // Create token transfer
    const tokenTransfer = new TokenTransfer({
        id: `${transaction.hash}-${log.logIndex}`,
        token: token,
        transaction: transaction,
        log: logEntity,
        fromAddress: fromAddress,
        toAddress: toAddress,
        value: value,
        timestamp: transaction.timestamp,
    })
    tokenTransfers.push(tokenTransfer)
}
