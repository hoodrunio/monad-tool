import {TypeormDatabase} from '@subsquid/typeorm-store'
import {Block, Transaction, Account, Log, Contract, TokenTransfer, Token, MethodSignature} from './model'
import {processor} from './processor'
import {EnhancedProcessor} from './services/EnhancedProcessor'
import {logger} from './utils/logger'


// Enhanced token processing configuration
const ENHANCED_PROCESSING_CONFIG = {
    enableTokenEnrichment: process.env.ENABLE_TOKEN_ENRICHMENT === 'true',
    enableAsyncProcessing: process.env.ENABLE_ASYNC_PROCESSING === 'true',
    rpcUrl: process.env.RPC_MONAD_HTTP || 'https://testnet-rpc.monad.xyz',
    rabbitMqUrl: process.env.RABBITMQ_URL || 'amqp://localhost:5672',
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '3'),
    retryAttempts: parseInt(process.env.RETRY_ATTEMPTS || '3'),
    retryDelay: parseInt(process.env.RETRY_DELAY || '1000'),
}
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

// Initialize enhanced processor and token enrichment worker
let enhancedProcessor: EnhancedProcessor | null = null

processor.run(new TypeormDatabase({supportHotBlocks: true}), async (ctx) => {
    // Initialize enhanced processing on first run if enabled
    if (ENHANCED_PROCESSING_CONFIG.enableTokenEnrichment && !enhancedProcessor) {
        logger.info('Initializing enhanced token processing...', ENHANCED_PROCESSING_CONFIG)
        
        try {
            // Initialize enhanced processor with RPC URL for sync metadata enrichment
            enhancedProcessor = new EnhancedProcessor(processor, {
                enableTokenEnrichment: ENHANCED_PROCESSING_CONFIG.enableTokenEnrichment,
                enableAsyncProcessing: false, // Disable async for now, process synchronously
                enrichmentWorker: undefined,
                rpcUrl: ENHANCED_PROCESSING_CONFIG.rpcUrl,
            })

            logger.info('Enhanced token processing initialized successfully')
        } catch (error) {
            logger.error('Failed to initialize enhanced processing', {
                error: error instanceof Error ? error.message : 'Unknown error'
            })
            enhancedProcessor = null
        }
    }
    const blocks: Block[] = []
    const transactions: Transaction[] = []
    const accounts: Map<string, Account> = new Map()
    const logs: Log[] = []
    const contracts: Contract[] = []
    const tokens: Map<string, Token> = new Map()
    const tokenTransfers: TokenTransfer[] = []
    const methodSignatures: Map<string, MethodSignature> = new Map()

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
            }
        }
    }

    // Process token transfers with enhanced processor if available
    if (enhancedProcessor && logs.length > 0) {
        try {
            logger.info('Processing logs with enhanced processor', { logCount: logs.length })
            
            // Create lookup maps for enhanced processor
            const transactionMap = new Map<string, Transaction>()
            const logMap = new Map<string, Log>()
            
            transactions.forEach(tx => transactionMap.set(tx.hash, tx))
            logs.forEach(log => logMap.set(log.id, log))
            
            // Convert logs to format expected by enhanced processor
            const logItems = logs
                .filter(log => log.topics.length > 0 && 
                    (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' || // ERC20/ERC721 Transfer
                     log.topics[0] === '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62' || // ERC1155 TransferSingle
                     log.topics[0] === '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb')) // ERC1155 TransferBatch
                .map(log => ({
                    address: log.address,
                    topics: log.topics,
                    data: log.data,
                    transaction: {
                        hash: log.transaction.hash,
                        block: {
                            height: log.transaction.block.number,
                            timestamp: Math.floor(log.transaction.timestamp.getTime() / 1000)
                        }
                    },
                    logIndex: log.logIndex
                }))

            // Process with enhanced processor, passing transaction and log maps
            const enhancedResult = await enhancedProcessor.processLogs(ctx.store, logItems, {
                transactionMap,
                logMap
            })
            
            // Add enhanced results to main collections
            if (enhancedResult.tokens.length > 0) {
                enhancedResult.tokens.forEach(token => tokens.set(token.address, token))
            }
            
            if (enhancedResult.transfers.length > 0) {
                tokenTransfers.push(...enhancedResult.transfers)
            }
            
            logger.info('Enhanced log processing completed successfully', {
                enrichedTokens: enhancedResult.tokens.length,
                enhancedTransfers: enhancedResult.transfers.length
            })
        } catch (error) {
            logger.error('Enhanced log processing failed, falling back to basic processing', {
                error: error instanceof Error ? error.message : 'Unknown error'
            })
            // Fallback handled above in the basic processing loop
        }
    }

    // Save all entities in batches for optimal performance
    await ctx.store.upsert([...accounts.values()])
    await ctx.store.upsert([...methodSignatures.values()])
    await ctx.store.insert(blocks)
    await ctx.store.insert(transactions)
    await ctx.store.insert(logs)
    // Save all tokens first
    if (tokens.size > 0) {
        await ctx.store.upsert([...tokens.values()])
    }

    // Insert token transfers - enhanced processor now adds to the same array
    if (tokenTransfers.length > 0) {
        await ctx.store.insert(tokenTransfers)
    }

    // Log processing summary
    const startBlock = ctx.blocks.at(0)?.header.height
    const endBlock = ctx.blocks.at(-1)?.header.height
    ctx.log.info(`Processed blocks ${startBlock} to ${endBlock}: ${blocks.length} blocks, ${transactions.length} transactions, ${accounts.size} accounts, ${methodSignatures.size} method signatures`)
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


