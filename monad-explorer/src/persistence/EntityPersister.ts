import { ProcessingResult } from '../processing/BlockProcessor';
import { logger } from '../utils/logger';

/**
 * Entity Persister
 * Single Responsibility: Only handles database persistence operations
 */
export class EntityPersister {
  
  /**
   * Persist all processed entities to the database
   */
  public async persistEntities(store: any, result: ProcessingResult): Promise<void> {
    const startTime = Date.now();
    
    logger.info('Starting entity persistence', {
      blocks: result.blocks.length,
      transactions: result.transactions.length,
      accounts: result.accounts.size,
      logs: result.logs.length,
      methodSignatures: result.methodSignatures.size,
      tokenTransfers: result.tokenTransfers.length,
      enrichedTokens: result.enrichedTokens.length,
    });

    try {
      // Persist entities in optimal order to respect foreign key constraints
      await this.persistAccounts(store, result);
      await this.persistMethodSignatures(store, result);
      await this.persistBlocks(store, result);
      await this.persistTransactions(store, result);
      await this.persistLogs(store, result);
      await this.persistTokens(store, result);
      await this.persistTokenTransfers(store, result);

      const duration = Date.now() - startTime;
      logger.info('Entity persistence completed successfully', {
        duration,
        totalEntities: this.calculateTotalEntities(result),
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Entity persistence failed', {
        duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist account entities
   */
  private async persistAccounts(store: any, result: ProcessingResult): Promise<void> {
    if (result.accounts.size === 0) {
      return;
    }

    try {
      const accountArray = [...result.accounts.values()];
      await store.upsert(accountArray);
      
      logger.debug('Accounts persisted successfully', { 
        count: accountArray.length 
      });
    } catch (error) {
      logger.error('Failed to persist accounts', {
        count: result.accounts.size,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist method signature entities
   */
  private async persistMethodSignatures(store: any, result: ProcessingResult): Promise<void> {
    if (result.methodSignatures.size === 0) {
      return;
    }

    try {
      const methodArray = [...result.methodSignatures.values()];
      await store.upsert(methodArray);
      
      logger.debug('Method signatures persisted successfully', { 
        count: methodArray.length 
      });
    } catch (error) {
      logger.error('Failed to persist method signatures', {
        count: result.methodSignatures.size,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist block entities
   */
  private async persistBlocks(store: any, result: ProcessingResult): Promise<void> {
    if (result.blocks.length === 0) {
      return;
    }

    try {
      await store.insert(result.blocks);
      
      logger.debug('Blocks persisted successfully', { 
        count: result.blocks.length,
        blockRange: `${result.blocks[0]?.number}-${result.blocks[result.blocks.length - 1]?.number}`,
      });
    } catch (error) {
      logger.error('Failed to persist blocks', {
        count: result.blocks.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist transaction entities
   */
  private async persistTransactions(store: any, result: ProcessingResult): Promise<void> {
    if (result.transactions.length === 0) {
      return;
    }

    try {
      await store.insert(result.transactions);
      
      logger.debug('Transactions persisted successfully', { 
        count: result.transactions.length 
      });
    } catch (error) {
      logger.error('Failed to persist transactions', {
        count: result.transactions.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist log entities
   */
  private async persistLogs(store: any, result: ProcessingResult): Promise<void> {
    if (result.logs.length === 0) {
      return;
    }

    try {
      await store.insert(result.logs);
      
      logger.debug('Logs persisted successfully', { 
        count: result.logs.length 
      });
    } catch (error) {
      logger.error('Failed to persist logs', {
        count: result.logs.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist token entities (must be before token transfers due to foreign key constraints)
   */
  private async persistTokens(store: any, result: ProcessingResult): Promise<void> {
    if (result.enrichedTokens.length === 0) {
      return;
    }

    try {
      await store.upsert(result.enrichedTokens);
      
      logger.debug('Tokens persisted successfully', { 
        count: result.enrichedTokens.length 
      });
    } catch (error) {
      logger.error('Failed to persist tokens', {
        count: result.enrichedTokens.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Persist token transfer entities
   */
  private async persistTokenTransfers(store: any, result: ProcessingResult): Promise<void> {
    if (result.tokenTransfers.length === 0) {
      return;
    }

    try {
      await store.insert(result.tokenTransfers);
      
      logger.debug('Token transfers persisted successfully', { 
        count: result.tokenTransfers.length 
      });
    } catch (error) {
      logger.error('Failed to persist token transfers', {
        count: result.tokenTransfers.length,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Calculate total number of entities to persist
   */
  private calculateTotalEntities(result: ProcessingResult): number {
    return result.blocks.length +
           result.transactions.length +
           result.accounts.size +
           result.logs.length +
           result.methodSignatures.size +
           result.tokenTransfers.length +
           result.enrichedTokens.length;
  }

  /**
   * Get persistence statistics
   */
  public getPersistenceStats(result: ProcessingResult): {
    totalEntities: number;
    entityBreakdown: Record<string, number>;
  } {
    const entityBreakdown = {
      blocks: result.blocks.length,
      transactions: result.transactions.length,
      accounts: result.accounts.size,
      logs: result.logs.length,
      methodSignatures: result.methodSignatures.size,
      tokenTransfers: result.tokenTransfers.length,
      enrichedTokens: result.enrichedTokens.length,
    };

    return {
      totalEntities: this.calculateTotalEntities(result),
      entityBreakdown,
    };
  }
} 