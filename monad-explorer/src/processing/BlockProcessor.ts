import { serviceContainer } from '../services/core/ServiceContainer';
import { ITokenDetectionService } from '../interfaces/services/ITokenDetectionService';
import { IContractDiscoveryService } from '../interfaces/services/IContractDiscoveryService';
import { ILogTokenTransferParser } from '../interfaces/processing/ILogTokenTransferParser';
import { logger } from '../utils/logger';
import { Account, Block, Transaction, Log, MethodSignature, Token, TokenType, TokenEnrichmentStatus, Contract } from '../model/generated';

export interface ProcessingResult {
  blocks: Block[];
  transactions: Transaction[];
  accounts: Map<string, Account>;
  logs: Log[];
  methodSignatures: Map<string, MethodSignature>;
  tokens: Token[];
  contracts: Contract[];
  discoveredContracts: Contract[]; // ✅ On-demand discovered contracts
  // ✅ TokenTransfers are now runtime-computed from logs, not stored
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

      // Process contract discovery (on-demand detection of unknown contracts)
      await this.processContractDiscovery(result, store);

      // Process token detection if enabled
      await this.processTokenDetection(result, store);

      const duration = Date.now() - startTime;
      logger.info('Block processing completed successfully', {
        duration,
        blocksProcessed: result.blocks.length,
        transactionsProcessed: result.transactions.length,
        logsProcessed: result.logs.length,
        accountsProcessed: result.accounts.size,
        tokensEnriched: result.tokens.length,
        contractsCreated: result.contracts.length,
        contractsDiscovered: result.discoveredContracts.length,
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

      // Process contract creation if this is a contract creation transaction
      if (processedTx.isContractCreation && processedTx.contractAddress) {
        this.processContractCreation(processedTx, result);
      }

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
   * Process contract creation
   */
  private async processContractCreation(transaction: Transaction, result: ProcessingResult): Promise<void> {
    if (!transaction.contractAddress) {
      return;
    }

    // Check if contract already exists (prevent duplicates)
    const existingContract = result.contracts.find(c => 
      c.address.toLowerCase() === transaction.contractAddress!.toLowerCase()
    );
    
    if (existingContract) {
      return;
    }

    // Create Contract entity
    const contract = new Contract({
      id: transaction.contractAddress.toLowerCase(),
      address: transaction.contractAddress.toLowerCase(),
      creator: transaction.fromAddress.toLowerCase(),
      creationTransaction: transaction,
      createdAt: transaction.timestamp,
      bytecode: null, // Will be fetched by background worker
      sourceCode: null, // Will be filled during verification
      isVerified: false,
      name: null, // Will be filled during verification
      compilerVersion: null, // Will be filled during verification
    });

    result.contracts.push(contract);

    // Queue contract for background enrichment
    await this.queueContractForEnrichment(transaction);

    logger.debug('Contract creation processed and queued for enrichment', {
      contractAddress: contract.address,
      creator: contract.creator,
      transactionHash: transaction.hash,
      blockNumber: transaction.block.number,
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
   * Process contract discovery (on-demand detection of unknown contracts)
   */
  private async processContractDiscovery(result: ProcessingResult, store: any): Promise<void> {
    try {
      const config = await this.container.resolve<any>('appConfig');
      
      if (!config.processor.enableContractDiscovery) {
        logger.debug('Contract discovery disabled', {
          transactionCount: result.transactions.length,
          logCount: result.logs.length,
        });
        return;
      }

      const contractDiscoveryService = await this.container.resolve<IContractDiscoveryService>('contractDiscoveryService');
      
      // Discover contracts from transactions and logs
      const transactionContracts = await contractDiscoveryService.discoverFromTransactions(
        result.transactions, 
        result.blocks[0]?.number || 0
      );
      
      const logContracts = await contractDiscoveryService.discoverFromLogs(
        result.logs, 
        result.blocks[0]?.number || 0
      );

      // Combine and deduplicate discovered contracts
      const allDiscovered = [...transactionContracts, ...logContracts];
      const uniqueDiscovered = new Map<string, any>();
      
      for (const discovered of allDiscovered) {
        if (!uniqueDiscovered.has(discovered.address)) {
          uniqueDiscovered.set(discovered.address, discovered);
        }
      }

      if (uniqueDiscovered.size > 0) {
        // Create basic contract entities
        const basicContracts = await contractDiscoveryService.createBasicContracts(
          Array.from(uniqueDiscovered.values())
        );

        result.discoveredContracts.push(...basicContracts);

        // Queue discovered contracts for background enrichment
        for (const contract of basicContracts) {
          try {
            await this.queueDiscoveredContractForEnrichment(contract);
          } catch (error) {
            logger.warn('Failed to queue discovered contract for enrichment', {
              contractAddress: contract.address,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }

        logger.debug('Contract discovery completed', {
          transactionContracts: transactionContracts.length,
          logContracts: logContracts.length,
          uniqueDiscovered: uniqueDiscovered.size,
          queued: uniqueDiscovered.size,
        });
      } else {
        logger.debug('No new contracts discovered', {
          transactionCount: result.transactions.length,
          logCount: result.logs.length,
        });
      }

    } catch (error) {
      logger.error('Contract discovery processing failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Process token detection if enabled
   */
  private async processTokenDetection(result: ProcessingResult, store: any): Promise<void> {
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
      
      // Filter logs that might be token events
      const tokenLogs = this.filterTokenEventLogs(result.logs);
      
      logger.debug('Processing potential token event logs', {
        totalLogs: result.logs.length,
        tokenLogs: tokenLogs.length,
      });

      // Process token detection for each relevant log
      for (const log of tokenLogs) {
        try {
          await this.processTokenDetectionLog(log, tokenDetectionService, result, store);
        } catch (error) {
          logger.warn('Failed to process token detection log', {
            logId: log.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      logger.info('Token detection processing completed', {
        processedLogs: tokenLogs.length,
        enrichedTokens: result.tokens.length,
      });

    } catch (error) {
      logger.error('Token transfer processing failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Filter logs that might be token events
   */
  private filterTokenEventLogs(logs: any[]): any[] {
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
   * Process a single token detection log with event-based detection
   */
  private async processTokenDetectionLog(
    log: any,
    tokenDetectionService: ITokenDetectionService,
    result: ProcessingResult,
    store: any
  ): Promise<void> {
    // ✅ EVENT-BASED DETECTION: Pass the log event for analysis
    const transferLog = {
      address: log.address,
      topics: log.topics,
      data: log.data,
    };

    const detection = await tokenDetectionService.detectTokenType(log.address, {
      blockNumber: log.transaction.block.number,
      transferLog: transferLog, // Pass the event for analysis
    });

    if (detection.detectedType) {
      // ✅ Create Token entity FIRST (ensure it exists before creating transfer)
      let tokenEntity = result.tokens.find(t => t.address.toLowerCase() === log.address.toLowerCase());
      
      if (!tokenEntity) {
        // Create basic token entity without metadata - will be enriched by worker
        tokenEntity = new Token({
          id: log.address.toLowerCase(),
          address: log.address.toLowerCase(),
          name: null, // Will be enriched by worker
          symbol: null, // Will be enriched by worker  
          decimals: null, // Will be enriched by worker
          totalSupply: null, // Will be enriched by worker
          tokenType: detection.detectedType as TokenType,
          createdAt: log.transaction.timestamp,
          enrichmentStatus: 'PENDING' as TokenEnrichmentStatus, // Will be enriched by worker
          enrichedAt: null,
          enrichmentAttempts: 0,
        });

        result.tokens.push(tokenEntity);

        // Queue the token for enrichment (metadata will be fetched by worker)
        const config = await this.container.resolve<any>('appConfig');
        if (config.processor.enableAsyncProcessing) {
          try {
            await this.queueTokenForEnrichment(log, detection.detectedType);
          } catch (error) {
            logger.warn('Failed to queue token for enrichment', {
              tokenAddress: log.address,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
            // Don't throw - continue processing even if queueing fails
          }
        }
      }

      // ✅ Extract NFT token ID for ERC721/1155 (from topics[3] if exists)
      let nftTokenId = '0'; // Default for ERC20 (string format)
      if (detection.detectedType === TokenType.ERC721 || detection.detectedType === TokenType.ERC1155) {
        try {
          if (log.topics[3]) {
            nftTokenId = BigInt(log.topics[3]).toString();
          }
        } catch (error) {
          logger.debug('Failed to parse NFT token ID, using 0', { address: log.address });
        }
      }

      // ✅ LOGS-FIRST APPROACH: TokenTransfers are now computed at runtime from logs
      // No need to store TokenTransfer entities - they will be parsed from logs when needed
      /* logger.debug('Token detected and stored', {
        tokenAddress: log.address,
        tokenType: detection.detectedType,
        fromAddress: log.topics[1] ? `0x${log.topics[1].slice(26)}` : '0x0000000000000000000000000000000000000000',
        toAddress: log.topics[2] ? `0x${log.topics[2].slice(26)}` : '0x0000000000000000000000000000000000000000',
        nftTokenId: nftTokenId,
      }); */

    } else {
      logger.debug('Log is not a token transfer event', {
        address: log.address,
        topics: log.topics.length,
      });
    }
  }

  /**
   * Queue token for background enrichment
   */
  private async queueTokenForEnrichment(log: any, detectedType: string): Promise<void> {
    try {
      const queueService = await this.container.resolve<any>('queueService');
      
      if (!queueService.isConnected()) {
        logger.debug('Queue service not connected - skipping token enrichment queue');
        return;
      }

      const enrichmentMessage = {
        tokenAddress: log.address,
        blockNumber: log.transaction.block.number,
        transactionHash: log.transaction.hash,
        logIndex: log.logIndex,
        detectedType: detectedType,
      };

      await queueService.publishTokenEnrichment(enrichmentMessage, {
        priority: 5,
        persistent: true,
      });

      /* logger.debug('Token queued for enrichment', {
        tokenAddress: log.address,
        blockNumber: log.transaction.block.number,
      }); */

    } catch (error) {
      logger.error('Failed to queue token for enrichment', {
        tokenAddress: log.address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Queue contract for background enrichment
   */
  private async queueContractForEnrichment(transaction: Transaction): Promise<void> {
    try {
      const config = await this.container.resolve<any>('appConfig');
      
      if (!config.processor.enableAsyncProcessing) {
        logger.debug('Async processing disabled - skipping contract enrichment queue');
        return;
      }

      const queueService = await this.container.resolve<any>('queueService');
      
      if (!queueService.isConnected()) {
        logger.debug('Queue service not connected - skipping contract enrichment queue');
        return;
      }

      const enrichmentMessage = {
        contractAddress: transaction.contractAddress!,
        creator: transaction.fromAddress,
        blockNumber: transaction.block.number,
        transactionHash: transaction.hash,
        deploymentBytecode: transaction.input || undefined,
      };

      await queueService.publishContractEnrichment(enrichmentMessage, {
        priority: 3, // Lower priority than tokens
        persistent: true,
      });

      logger.debug('Contract queued for enrichment', {
        contractAddress: transaction.contractAddress,
        creator: transaction.fromAddress,
        blockNumber: transaction.block.number,
      });

    } catch (error) {
      logger.warn('Failed to queue contract for enrichment', {
        contractAddress: transaction.contractAddress,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing even if queueing fails
    }
  }

  /**
   * Queue discovered contract for background enrichment
   */
  private async queueDiscoveredContractForEnrichment(contract: Contract): Promise<void> {
    try {
      const config = await this.container.resolve<any>('appConfig');
      
      if (!config.processor.enableAsyncProcessing) {
        logger.debug('Async processing disabled - skipping discovered contract enrichment queue');
        return;
      }

      const queueService = await this.container.resolve<any>('queueService');
      
      if (!queueService.isConnected()) {
        logger.debug('Queue service not connected - skipping discovered contract enrichment queue');
        return;
      }

      const enrichmentMessage = {
        contractAddress: contract.address,
        creator: contract.creator,
        blockNumber: null, // Discovery block number not always available
        transactionHash: null, // Original deployment transaction unknown
        deploymentBytecode: undefined, // Will be fetched during enrichment
        discoveredContract: true, // Flag to indicate this is a discovered contract
      };

      await queueService.publishContractEnrichment(enrichmentMessage, {
        priority: 5, // Lower priority than creation contracts
        persistent: true,
      });

      /* logger.debug('Discovered contract queued for enrichment', {
        contractAddress: contract.address,
        creator: contract.creator,
      }); */

    } catch (error) {
      logger.warn('Failed to queue discovered contract for enrichment', {
        contractAddress: contract.address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing even if queueing fails
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
      tokens: [],
      contracts: [],
      discoveredContracts: [],
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
   * Uses Ethereum CREATE opcode address calculation
   * Note: This is a simplified version. Real implementation would use RLP encoding + Keccak256
   */
  private calculateContractAddress(from: string, nonce: bigint): string {
    // Simplified contract address calculation
    // In production, this should use: keccak256(rlp([sender, nonce]))
    const normalized = from.toLowerCase().replace('0x', '');
    const nonceHex = nonce.toString(16).padStart(16, '0');
    
    // Create a deterministic address based on sender + nonce
    // This is a simplified approach - real Ethereum uses RLP + Keccak256
    const addressSuffix = (normalized + nonceHex).slice(-40);
    return `0x${addressSuffix}`;
  }
} 