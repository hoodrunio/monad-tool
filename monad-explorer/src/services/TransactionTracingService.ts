export interface TraceCall {
    type: string
    from: string
    to?: string
    value: string
    gas: string
    gasUsed: string
    input?: string
    output?: string
    error?: string
    calls?: TraceCall[]
}

export interface TransactionTrace {
    type: string
    from: string
    to?: string
    value: string
    gas: string
    gasUsed: string
    input?: string
    output?: string
    error?: string
    calls?: TraceCall[]
}

export interface ParsedInternalTransaction {
    traceIndex: number
    type: string
    fromAddress: string
    toAddress?: string
    value: bigint
    gas: bigint
    gasUsed: bigint
    input?: string
    output?: string
    error?: string
    parentTraceIndex?: number
}

export class TransactionTracingService {
    private rpcUrl: string
    private cache: Map<string, ParsedInternalTransaction[]> = new Map()

    constructor(rpcUrl: string) {
        this.rpcUrl = rpcUrl
    }

    async getTransactionTrace(txHash: string): Promise<ParsedInternalTransaction[]> {
        // Check cache first
        if (this.cache.has(txHash.toLowerCase())) {
            return this.cache.get(txHash.toLowerCase())!
        }

        try {
            const response = await fetch(this.rpcUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'debug_traceTransaction',
                    params: [txHash, { tracer: 'callTracer' }],
                    id: 1
                })
            })

            const data = await response.json()
            
            if (data.error) {
                console.warn(`Trace error for ${txHash}:`, data.error)
                return []
            }

            if (!data.result) {
                return []
            }

            const traces = this.parseTrace(data.result)
            this.cache.set(txHash.toLowerCase(), traces)
            return traces

        } catch (error) {
            console.warn(`Failed to fetch trace for ${txHash}:`, error)
            return []
        }
    }

    private parseTrace(trace: TransactionTrace): ParsedInternalTransaction[] {
        const internalTxs: ParsedInternalTransaction[] = []
        const traceIndex = { value: 0 }

        // Parse the main call and its subcalls
        this.parseTraceRecursive(trace, internalTxs, traceIndex, undefined)

        return internalTxs
    }

    private parseTraceRecursive(
        call: TraceCall,
        internalTxs: ParsedInternalTransaction[],
        traceIndex: { value: number },
        parentTraceIndex?: number
    ): void {
        // Only add internal calls (subcalls), not the main transaction
        if (parentTraceIndex !== undefined) {
            const internalTx: ParsedInternalTransaction = {
                traceIndex: traceIndex.value,
                type: call.type,
                fromAddress: call.from.toLowerCase(),
                toAddress: call.to?.toLowerCase(),
                value: this.hexToBigInt(call.value),
                gas: this.hexToBigInt(call.gas),
                gasUsed: this.hexToBigInt(call.gasUsed),
                input: call.input,
                output: call.output,
                error: call.error,
                parentTraceIndex: parentTraceIndex
            }
            internalTxs.push(internalTx)
        }

        const currentTraceIndex = traceIndex.value
        traceIndex.value++

        // Process subcalls
        if (call.calls && call.calls.length > 0) {
            for (const subCall of call.calls) {
                this.parseTraceRecursive(subCall, internalTxs, traceIndex, currentTraceIndex)
            }
        }
    }

    private hexToBigInt(hex: string): bigint {
        if (!hex || hex === '0x' || hex === '0x0') {
            return 0n
        }
        return BigInt(hex)
    }

    // Batch fetch traces for multiple transactions
    async getTransactionTracesBatch(txHashes: string[]): Promise<Map<string, ParsedInternalTransaction[]>> {
        const results = new Map<string, ParsedInternalTransaction[]>()
        
        // Process in smaller batches to avoid overwhelming the RPC
        const batchSize = 5
        for (let i = 0; i < txHashes.length; i += batchSize) {
            const batch = txHashes.slice(i, i + batchSize)
            const promises = batch.map(async (txHash) => {
                const traces = await this.getTransactionTrace(txHash)
                results.set(txHash.toLowerCase(), traces)
            })
            
            await Promise.allSettled(promises)
            
            // Small delay to avoid rate limiting
            if (i + batchSize < txHashes.length) {
                await new Promise(resolve => setTimeout(resolve, 200))
            }
        }
        
        return results
    }

    // Check if a transaction should be traced (only trace transactions with contract interactions)
    shouldTraceTransaction(transaction: {
        to?: string
        input?: string
        gasUsed?: bigint
        status?: number
    }): boolean {
        // Only trace successful contract interactions that used significant gas
        return Boolean(
            transaction.to && // Has a recipient (not contract creation)
            transaction.input && transaction.input.length > 2 && // Has input data
            transaction.gasUsed && transaction.gasUsed > 21000n && // Used more than basic transfer gas
            transaction.status === 1 // Was successful
        )
    }

    clearCache(): void {
        this.cache.clear()
    }

    getCacheSize(): number {
        return this.cache.size
    }
} 