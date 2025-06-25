import {TypeormDatabase} from '@subsquid/typeorm-store'
import {Block, Transaction, Account, Log, Contract, TokenTransfer, Token, DailyStats, TokenType, MethodSignature, InternalTransaction} from './model'
import {processor} from './processor'
import {TokenMetadataService} from './services/TokenMetadataService'
import {TransactionTracingService} from './services/TransactionTracingService'

// Common token signatures
const ERC20_TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ERC721_TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// Common method signatures cache
const KNOWN_METHODS: Map<string, {name: string, signature: string}> = new Map([
    ['0xa9059cbb', {name: 'transfer', signature: 'transfer(address,uint256)'}],
    ['0x095ea7b3', {name: 'approve', signature: 'approve(address,uint256)'}],
    ['0x23b872dd', {name: 'transferFrom', signature: 'transferFrom(address,address,uint256)'}],
    ['0x70a08231', {name: 'balanceOf', signature: 'balanceOf(address)'}],
    ['0xdd62ed3e', {name: 'allowance', signature: 'allowance(address,address)'}],
    ['0x18160ddd', {name: 'totalSupply', signature: 'totalSupply()'}],
    ['0x06fdde03', {name: 'name', signature: 'name()'}],
    ['0x95d89b41', {name: 'symbol', signature: 'symbol()'}],
    ['0x313ce567', {name: 'decimals', signature: 'decimals()'}],
    ['0xb401faf1', {name: 'claimWinnings', signature: 'claimWinnings()'}],
    ['0x6a627842', {name: 'setApprovalForAll', signature: 'setApprovalForAll(address,bool)'}],
])

// Initialize services
const RPC_URL = process.env.RPC_MONAD_HTTP || 'https://testnet-rpc.monad.xyz'
const tokenMetadataService = new TokenMetadataService(RPC_URL)
const tracingService = new TransactionTracingService(RPC_URL)

processor.run(new TypeormDatabase({supportHotBlocks: true}), async (ctx) => {
    const blocks: Block[] = []
    const transactions: Transaction[] = []
    const accounts: Map<string, Account> = new Map()
    const logs: Log[] = []
    const contracts: Contract[] = []
    const tokens: Map<string, Token> = new Map()
    const tokenTransfers: TokenTransfer[] = []
    const methodSignatures: Map<string, MethodSignature> = new Map()
    const internalTransactions: InternalTransaction[] = []

    // Collect all token addresses for batch metadata fetching
    const tokenAddressesSet = new Set<string>()
    // Collect transactions that need tracing
    const transactionsToTrace: {hash: string, transaction: Transaction}[] = []

    for (let c of ctx.blocks) {
        // Process Block with enhanced fields
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
            // Enhanced block fields
            miner: c.header.miner || '',
            extraData: c.header.extraData || '0x',
            baseFeePerGas: BigInt(c.header.baseFeePerGas || 0),
        })
        blocks.push(block)

        // Process Transactions with enhanced fields
        for (let tx of c.transactions) {
            // Calculate effective gas price
            const baseFeePerGas = BigInt(c.header.baseFeePerGas || 0)
            const maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas || 0)
            const maxFeePerGas = BigInt(tx.maxFeePerGas || 0)
            const gasPrice = BigInt(tx.gasPrice || 0)
            
            // For EIP-1559 transactions (type 2), calculate effective gas price
            let effectiveGasPrice: bigint
            if (tx.type === 2) {
                effectiveGasPrice = baseFeePerGas + maxPriorityFeePerGas
                if (effectiveGasPrice > maxFeePerGas) {
                    effectiveGasPrice = maxFeePerGas
                }
            } else {
                effectiveGasPrice = gasPrice
            }

            // Calculate transaction fee
            const transactionFee = BigInt(tx.gasUsed || 0) * effectiveGasPrice

            // Extract method information
            const methodInfo = extractMethodInfo(tx.input)
            
            // Detect contract interaction and creation
            const isContractCreation = !tx.to
            const isContractInteraction = Boolean(tx.to && tx.input && tx.input.length > 2)

            const transaction = new Transaction({
                id: tx.hash,
                hash: tx.hash,
                block: block,
                transactionIndex: tx.transactionIndex,
                fromAddress: tx.from,
                toAddress: tx.to,
                value: tx.value,
                gas: BigInt(tx.gas || 0),
                gasPrice: gasPrice,
                gasUsed: BigInt(tx.gasUsed || 0),
                input: tx.input,
                status: tx.status,
                timestamp: block.timestamp,
                // Enhanced transaction fields
                nonce: BigInt(tx.nonce || 0),
                type: tx.type || 0,
                effectiveGasPrice: effectiveGasPrice,
                maxFeePerGas: maxFeePerGas,
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                contractAddress: isContractCreation ? calculateContractAddress(tx.from, BigInt(tx.nonce || 0)) : null,
                cumulativeGasUsed: BigInt(tx.cumulativeGasUsed || 0),
                transactionFee: transactionFee,
                methodName: methodInfo.name,
                methodID: methodInfo.id,
                inputDecoded: null, // Will be populated later with proper ABI decoding
                isContractInteraction: isContractInteraction,
                isContractCreation: isContractCreation,
            })
            transactions.push(transaction)

            // Check if this transaction needs tracing
            if (tracingService.shouldTraceTransaction({
                to: tx.to,
                input: tx.input,
                gasUsed: BigInt(tx.gasUsed || 0),
                status: tx.status
            })) {
                transactionsToTrace.push({hash: tx.hash, transaction})
            }

            // Store method signature if not known
            if (methodInfo.id && !methodSignatures.has(methodInfo.id)) {
                const knownMethod = KNOWN_METHODS.get(methodInfo.id)
                if (knownMethod) {
                    methodSignatures.set(methodInfo.id, new MethodSignature({
                        id: methodInfo.id,
                        methodId: methodInfo.id,
                        signature: knownMethod.signature,
                        name: knownMethod.name,
                        verified: true,
                        source: 'builtin'
                    }))
                }
            }

            // Enhanced account processing
            await processAccount(tx.from, accounts, block.timestamp, false)
            if (tx.to) {
                const isContract = isContractInteraction || isContractCreation
                await processAccount(tx.to, accounts, block.timestamp, isContract)
            }

            // Process Logs with enhanced fields
            for (let log of tx.logs || []) {
                const logEntity = new Log({
                    id: `${tx.hash}-${log.logIndex}`,
                    transaction: transaction,
                    logIndex: log.logIndex,
                    address: log.address,
                    topics: log.topics,
                    data: log.data,
                    removed: false, // Default to false since field may not be available in RPC mode
                })
                logs.push(logEntity)

                // Check if this is a token transfer event
                if (log.topics[0] === ERC20_TRANSFER_SIGNATURE && log.topics.length >= 3) {
                    tokenAddressesSet.add(log.address.toLowerCase())
                    await processTokenTransfer(log, transaction, logEntity, tokens, tokenTransfers)
                }
            }
        }
    }

    // Batch fetch token metadata for all discovered tokens
    if (tokenAddressesSet.size > 0) {
        ctx.log.info(`Fetching metadata for ${tokenAddressesSet.size} tokens...`)
        const tokenMetadataMap = await tokenMetadataService.getTokenMetadataBatch([...tokenAddressesSet])
        
        // Update tokens with real metadata
        for (const [address, metadata] of tokenMetadataMap) {
            const token = tokens.get(address)
            if (token && metadata) {
                token.name = metadata.name
                token.symbol = metadata.symbol
                token.decimals = metadata.decimals
                token.totalSupply = metadata.totalSupply
                token.tokenType = metadata.tokenType as TokenType
            }
        }
    }

    // Batch fetch transaction traces for complex transactions
    if (transactionsToTrace.length > 0) {
        ctx.log.info(`Tracing ${transactionsToTrace.length} complex transactions...`)
        const traceMap = await tracingService.getTransactionTracesBatch(
            transactionsToTrace.map(t => t.hash)
        )

        // Process internal transactions
        for (const {hash, transaction} of transactionsToTrace) {
            const traces = traceMap.get(hash.toLowerCase()) || []
            for (const trace of traces) {
                const internalTx = new InternalTransaction({
                    id: `${hash}-${trace.traceIndex}`,
                    transaction: transaction,
                    traceIndex: trace.traceIndex,
                    type: trace.type,
                    fromAddress: trace.fromAddress,
                    toAddress: trace.toAddress || null,
                    value: trace.value,
                    gas: trace.gas,
                    gasUsed: trace.gasUsed,
                    input: trace.input || null,
                    output: trace.output || null,
                    error: trace.error || null,
                    parentTrace: trace.parentTraceIndex !== undefined ? 
                        internalTransactions.find(it => 
                            it.transaction.id === transaction.id && 
                            it.traceIndex === trace.parentTraceIndex
                        ) || null : null
                })
                internalTransactions.push(internalTx)
            }
        }
    }

    // Save all entities in batches for optimal performance
    await ctx.store.upsert([...accounts.values()])
    await ctx.store.upsert([...methodSignatures.values()])
    await ctx.store.insert(blocks)
    await ctx.store.insert(transactions)
    await ctx.store.insert(logs)
    await ctx.store.upsert([...tokens.values()])
    await ctx.store.insert(tokenTransfers)
    await ctx.store.insert(internalTransactions)

    // Log processing summary
    const startBlock = ctx.blocks.at(0)?.header.height
    const endBlock = ctx.blocks.at(-1)?.header.height
    const tracedTxs = transactionsToTrace.length
    const enrichedTokens = tokenAddressesSet.size
    const internalTxCount = internalTransactions.length
    
    ctx.log.info(`Processed blocks ${startBlock} to ${endBlock}: ${blocks.length} blocks, ${transactions.length} transactions, ${accounts.size} accounts, ${methodSignatures.size} method signatures, ${tracedTxs} traced txs (${internalTxCount} internal txs), ${enrichedTokens} tokens enriched`)
})

function extractMethodInfo(input: string | null): {id: string | null, name: string | null} {
    if (!input || input.length < 10) {
        return {id: null, name: null}
    }
    
    const methodId = input.slice(0, 10) // First 4 bytes (including 0x)
    const knownMethod = KNOWN_METHODS.get(methodId)
    
    return {
        id: methodId,
        name: knownMethod?.name || null
    }
}

function calculateContractAddress(from: string, nonce: bigint): string {
    // Simplified contract address calculation
    // In a full implementation, you'd use RLP encoding and keccak256
    // For now, return a placeholder that can be updated later
    return `${from}-contract-${nonce.toString()}`
}

async function processAccount(address: string, accounts: Map<string, Account>, timestamp: Date, isContract: boolean) {
    if (!accounts.has(address)) {
        accounts.set(address, new Account({
            id: address,
            address: address,
            balance: 0n,
            transactionCount: 0,
            isContract: isContract,
            contractCode: null,
            createdAt: timestamp,
            // Enhanced account fields
            contractType: isContract ? 'Contract' : 'EOA',
            isVerified: false,
            contractName: null,
            ensName: null,
        }))
    }
    const account = accounts.get(address)!
    account.transactionCount++
    
    // Update contract status if needed
    if (isContract && !account.isContract) {
        account.isContract = true
        account.contractType = 'Contract'
    }
}

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

    // Create or get token with default values (will be enhanced later)
    if (!tokens.has(tokenAddress.toLowerCase())) {
        tokens.set(tokenAddress.toLowerCase(), new Token({
            id: tokenAddress,
            address: tokenAddress,
            name: `Token ${tokenAddress.slice(0, 8)}...`, // Will be updated with real metadata
            symbol: 'UNKNOWN',
            decimals: 18, // Default, will be updated
            totalSupply: 0n,
            tokenType: TokenType.ERC20, // Default, will be updated
            createdAt: transaction.timestamp,
        }))
    }

    const token = tokens.get(tokenAddress.toLowerCase())!

    // Create token transfer
    const tokenTransfer = new TokenTransfer({
        id: `${transaction.hash}-${log.logIndex}`,
        token: token,
        transaction: transaction,
        log: logEntity,
        fromAddress: fromAddress,
        toAddress: toAddress,
        value: value,
        tokenId: null, // Will be set for NFTs
        timestamp: transaction.timestamp,
    })
    tokenTransfers.push(tokenTransfer)
}
