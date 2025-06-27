import { serviceContainer } from '../services/core/ServiceContainer';
import { ITokenDetectionService } from '../interfaces/services/ITokenDetectionService';
import { logger } from '../utils/logger';
import { Account, Block, Transaction, Log, MethodSignature } from '../model/generated';

export interface ProcessingResult {
  blocks: Block[];
  transactions: Transaction[];
  accounts: Map<string, Account>;
  logs: Log[];
  methodSignatures: Map<string, MethodSignature>;
  tokenTransfers: any[];
  enrichedTokens: any[];
}

/**
 * Block Processor
 * Single Responsibility: Only handles blockchain data processing
 */
export class BlockProcessor {
  constructor(private readonly container: typeof serviceContainer) {}

  /**
   * Process a batch of blocks
   */
  public async processBlocks(blocks: any[], store: any): Promise<ProcessingResult> {
    const startTime = Date.now();
    
    logger.info('Starting block processing', {
      blockCount: blocks.length,
      startBlock: blocks.at(0)?.header.height,
      endBlock: blocks.at(-1)?.header.height,
    });

    try {
      // Initialize result structure
      const result = this.initializeResult();

      // Process each block
      for (const block of blocks) {
        await this.processBlock(block, result);
      }

      // Process token transfers if enabled
      await this.processTokenTransfers(result, store);

      const duration = Date.now() - startTime;
      logger.info('Block processing completed successfully', {
        duration,
        blocksProcessed: result.blocks.length,
        transactionsProcessed: result.transactions.length,
        logsProcessed: result.logs.length,
        accountsProcessed: result.accounts.size,
        tokenTransfersDetected: result.tokenTransfers.length,
        tokensEnriched: result.enrichedTokens.length,
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Block processing failed', {
        duration,
        blockCount: blocks.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Process a single block
   */
  private async processBlock(block: any, result: ProcessingResult): Promise<void> {
    // Process block data
    const processedBlock = this.createBlockEntity(block);
    result.blocks.push(processedBlock);

    // Process transactions
    for (const tx of block.transactions) {
      const processedTx = this.createTransactionEntity(tx, processedBlock);
      result.transactions.push(processedTx);

      // Process accounts
      this.processAccountEntity(tx.from, result.accounts, processedBlock.timestamp, false);
      if (tx.to) {
        const isContract = Boolean(tx.to && tx.input && tx.input.length > 2);
        this.processAccountEntity(tx.to, result.accounts, processedBlock.timestamp, isContract);
      }

      // Process logs
      for (const log of tx.logs || []) {
        const processedLog = this.createLogEntity(log, processedTx);
        result.logs.push(processedLog);
      }

      // Process method signatures
      this.processMethodSignature(tx.input, result.methodSignatures);
    }
  }

  /**
   * Create block entity with enhanced fields
   */
  private createBlockEntity(block: any): Block {
    return new Block({
      id: block.header.hash,
      number: block.header.height,
      hash: block.header.hash,
      parentHash: block.header.parentHash,
      timestamp: new Date(block.header.timestamp),
      size: BigInt(block.header.size || 0),
      gasLimit: BigInt(block.header.gasLimit || 0),
      gasUsed: BigInt(block.header.gasUsed || 0),
      transactionCount: block.transactions.length,
      miner: block.header.miner || '',
      extraData: block.header.extraData || '0x',
      baseFeePerGas: BigInt(block.header.baseFeePerGas || 0),
    });
  }

  /**
   * Create transaction entity with enhanced fields
   */
  private createTransactionEntity(tx: any, block: Block): Transaction {
    // Calculate effective gas price
    const baseFeePerGas = BigInt(block.baseFeePerGas || 0);
    const maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas || 0);
    const maxFeePerGas = BigInt(tx.maxFeePerGas || 0);
    const gasPrice = BigInt(tx.gasPrice || 0);
    
    let effectiveGasPrice: bigint;
    if (tx.type === 2) {
      effectiveGasPrice = baseFeePerGas + maxPriorityFeePerGas;
      if (effectiveGasPrice > maxFeePerGas) {
        effectiveGasPrice = maxFeePerGas;
      }
    } else {
      effectiveGasPrice = gasPrice;
    }

    const transactionFee = BigInt(tx.gasUsed || 0) * effectiveGasPrice;
    const methodInfo = this.extractMethodInfo(tx.input);
    const isContractCreation = !tx.to;
    const isContractInteraction = Boolean(tx.to && tx.input && tx.input.length > 2);

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
    });
  }

  /**
   * Create log entity
   */
  private createLogEntity(log: any, transaction: Transaction): Log {
    return new Log({
      id: `${transaction.hash}-${log.logIndex}`,
      transaction: transaction,
      logIndex: log.logIndex,
      address: log.address,
      topics: log.topics,
      data: log.data,
      removed: false,
    });
  }

  /**
   * Process account entity
   */
  private processAccountEntity(
    address: string, 
    accounts: Map<string, Account>, 
    timestamp: Date, 
    isContract: boolean
  ): void {
    if (!accounts.has(address)) {
      accounts.set(address, new Account({
        id: address,
        address: address,
        balance: 0n,
        transactionCount: 0,
        isContract: isContract,
        contractCode: null,
        createdAt: timestamp,
        contractType: isContract ? 'Contract' : 'EOA',
        isVerified: false,
        contractName: null,
        ensName: null,
      }));
    }
    
    const account = accounts.get(address)!;
    account.transactionCount++;
    
    if (isContract && !account.isContract) {
      account.isContract = true;
      account.contractType = 'Contract';
    }
  }

  /**
   * Process method signature
   */
  private processMethodSignature(input: string | null, methodSignatures: Map<string, MethodSignature>): void {
    const methodInfo = this.extractMethodInfo(input);
    
    if (methodInfo.id && !methodSignatures.has(methodInfo.id)) {
      // Get known method from a registry (could be injected as a service)
      const knownMethod = this.getKnownMethod(methodInfo.id);
      
      if (knownMethod) {
        methodSignatures.set(methodInfo.id, new MethodSignature({
          id: methodInfo.id,
          methodId: methodInfo.id,
          signature: knownMethod.signature,
          name: knownMethod.name,
          verified: true,
          source: 'builtin'
        }));
      }
    }
  }

  /**
   * Process token transfers if enabled
   */
  private async processTokenTransfers(result: ProcessingResult, store: any): Promise<void> {
    try {
      const config = await this.container.resolve<any>('appConfig');
      
      if (!config.processor.enableTokenEnrichment || result.logs.length === 0) {
        logger.debug('Token transfer processing skipped', {
          enabled: config.processor.enableTokenEnrichment,
          logCount: result.logs.length,
        });
        return;
      }

      const tokenDetectionService = await this.container.resolve<ITokenDetectionService>('tokenDetectionService');
      
      // Filter logs that might be token transfers
      const tokenLogs = this.filterTokenTransferLogs(result.logs);
      
      logger.debug('Processing potential token transfer logs', {
        totalLogs: result.logs.length,
        tokenLogs: tokenLogs.length,
      });

      // Process token detection for each relevant log
      for (const log of tokenLogs) {
        try {
          await this.processTokenTransferLog(log, tokenDetectionService, result, store);
        } catch (error) {
          logger.warn('Failed to process token transfer log', {
            logId: log.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      logger.info('Token transfer processing completed', {
        processedLogs: tokenLogs.length,
        detectedTransfers: result.tokenTransfers.length,
        enrichedTokens: result.enrichedTokens.length,
      });

    } catch (error) {
      logger.error('Token transfer processing failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Filter logs that might be token transfers
   */
  private filterTokenTransferLogs(logs: any[]): any[] {
    const transferSignatures = [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // ERC20/ERC721 Transfer
      '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', // ERC1155 TransferSingle
      '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb', // ERC1155 TransferBatch
    ];

    return logs.filter(log => 
      log.topics.length > 0 && 
      transferSignatures.includes(log.topics[0])
    );
  }

  /**
   * Process a single token transfer log
   */
  private async processTokenTransferLog(
    log: any,
    tokenDetectionService: ITokenDetectionService,
    result: ProcessingResult,
    store: any
  ): Promise<void> {
    // Detect token type
    const detection = await tokenDetectionService.detectTokenType(log.address, {
      blockNumber: log.transaction.block.number,
    });

    if (detection.detectedType) {
      logger.debug('Token detected', {
        address: log.address,
        type: detection.detectedType,
        confidence: detection.confidence,
      });

      // Here you would create the token transfer entity and token entity
      // This is where the enhanced processing would happen
      // For now, just log the detection
    }
  }

  /**
   * Initialize processing result structure
   */
  private initializeResult(): ProcessingResult {
    return {
      blocks: [],
      transactions: [],
      accounts: new Map(),
      logs: [],
      methodSignatures: new Map(),
      tokenTransfers: [],
      enrichedTokens: [],
    };
  }

  /**
   * Extract method information from transaction input
   */
  private extractMethodInfo(input: string | null): { id: string | null; name: string | null } {
    if (!input || input.length < 10) {
      return { id: null, name: null };
    }
    
    const methodId = input.slice(0, 10); // First 4 bytes (including 0x)
    const knownMethod = this.getKnownMethod(methodId);
    
    return {
      id: methodId,
      name: knownMethod?.name || null,
    };
  }

  /**
   * Get known method signature (could be from a service)
   */
  private getKnownMethod(methodId: string): { name: string; signature: string } | null {
    const knownMethods = new Map([
      ['0xa9059cbb', { name: 'transfer', signature: 'transfer(address,uint256)' }],
      ['0x095ea7b3', { name: 'approve', signature: 'approve(address,uint256)' }],
      ['0x23b872dd', { name: 'transferFrom', signature: 'transferFrom(address,address,uint256)' }],
      ['0x70a08231', { name: 'balanceOf', signature: 'balanceOf(address)' }],
      ['0xdd62ed3e', { name: 'allowance', signature: 'allowance(address,address)' }],
      ['0x18160ddd', { name: 'totalSupply', signature: 'totalSupply()' }],
      ['0x06fdde03', { name: 'name', signature: 'name()' }],
      ['0x95d89b41', { name: 'symbol', signature: 'symbol()' }],
      ['0x313ce567', { name: 'decimals', signature: 'decimals()' }],
    ]);

    return knownMethods.get(methodId) || null;
  }

  /**
   * Calculate contract address for contract creation transactions
   */
  private calculateContractAddress(from: string, nonce: bigint): string {
    return `${from}-contract-${nonce.toString()}`;
  }
} 