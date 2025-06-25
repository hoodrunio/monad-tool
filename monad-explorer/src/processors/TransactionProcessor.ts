import { Transaction, Block, MethodSignature } from '../model'
import { Transaction as SquidTransaction } from '../processor'

/**
 * Transaction Processor following Single Responsibility Principle
 * Responsible only for processing blockchain transactions
 */
export class TransactionProcessor {
  private readonly knownMethods: Map<string, {name: string, signature: string}>

  constructor() {
    this.knownMethods = new Map([
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
  }

  /**
   * Processes a single transaction into Transaction entity
   * @param tx - Transaction data from processor
   * @param block - Parent block entity
   * @returns Transaction entity ready for database storage
   */
  processTransaction(tx: SquidTransaction, block: Block): Transaction {
    const methodInfo = this.extractMethodInfo(tx.input)
    const isContractCreation = !tx.to
    const isContractInteraction = Boolean(tx.to && tx.input && tx.input.length > 2)
    
    // Calculate effective gas price
    const baseFeePerGas = block.baseFeePerGas || 0n
    const maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas || 0)
    const maxFeePerGas = BigInt(tx.maxFeePerGas || 0)
    const gasPrice = BigInt(tx.gasPrice || 0)
    
    let effectiveGasPrice: bigint
    if (tx.type === 2) {
      effectiveGasPrice = baseFeePerGas + maxPriorityFeePerGas
      if (effectiveGasPrice > maxFeePerGas) {
        effectiveGasPrice = maxFeePerGas
      }
    } else {
      effectiveGasPrice = gasPrice
    }

    const transactionFee = BigInt(tx.gasUsed || 0) * effectiveGasPrice

    return new Transaction({
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
      nonce: BigInt(tx.nonce || 0),
      type: tx.type || 0,
      effectiveGasPrice: effectiveGasPrice,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFeePerGas,
      contractAddress: isContractCreation ? this.calculateContractAddress(tx.from, BigInt(tx.nonce || 0)) : null,
      cumulativeGasUsed: BigInt(tx.cumulativeGasUsed || 0),
      transactionFee: transactionFee,
      methodName: methodInfo.name,
      methodID: methodInfo.id,
      inputDecoded: null,
      isContractInteraction: isContractInteraction,
      isContractCreation: isContractCreation,
    })
  }

  /**
   * Creates method signature entity if not known
   * @param methodId - Method identifier
   * @returns MethodSignature entity or null if unknown
   */
  createMethodSignature(methodId: string): MethodSignature | null {
    const knownMethod = this.knownMethods.get(methodId)
    if (!knownMethod) {
      return null
    }

    return new MethodSignature({
      id: methodId,
      methodId: methodId,
      signature: knownMethod.signature,
      name: knownMethod.name,
      verified: true,
      source: 'builtin'
    })
  }

  /**
   * Extracts method information from transaction input
   * @param input - Transaction input data
   * @returns Method information object
   */
  private extractMethodInfo(input: string | null): {id: string | null, name: string | null} {
    if (!input || input.length < 10) {
      return {id: null, name: null}
    }
    
    const methodId = input.slice(0, 10)
    const knownMethod = this.knownMethods.get(methodId)
    
    return {
      id: methodId,
      name: knownMethod?.name || null
    }
  }

  /**
   * Calculates contract address for contract creation transactions
   * @param from - Creator address
   * @param nonce - Transaction nonce
   * @returns Contract address
   */
  private calculateContractAddress(from: string, nonce: bigint): string {
    // Simplified contract address calculation
    return `${from}-contract-${nonce.toString()}`
  }
} 