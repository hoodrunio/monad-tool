import { ProcessingResult } from '../processing/BlockProcessor';
import { logger } from '../utils/logger';
import { In } from 'typeorm';

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
      tokens: result.tokens.length,
    });

    try {
      // Persist entities in optimal order to respect foreign key constraints
      await this.persistAccounts(store, result);
      await this.persistMethodSignatures(store, result);
      await this.persistBlocks(store, result);
      await this.persistTransactions(store, result);
      await this.persistLogs(store, result);
      await this.persistTokens(store, result);
      // ✅ TokenTransfers are now computed at runtime from logs - no persistence needed

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
   * Persist token entities 
   * SMART PERSISTENCE: Check existing tokens first, insert only new ones
   */
  private async persistTokens(store: any, result: ProcessingResult): Promise<void> {
    const successfulTokenIds = new Set<string>();
    
    if (result.tokens.length === 0) {
      return;
    }

    try {
      // ✅ STEP 1: Check which tokens already exist in database
      const tokenAddresses = result.tokens.map(t => t.address.toLowerCase());
      
      // Use Subsquid store to find existing tokens
      const existingTokens = await store.find('Token', {
        where: { 
          address: In(tokenAddresses)
        }
      });
      
      const existingAddresses = new Set(existingTokens.map((t: any) => t.address.toLowerCase()));
      
      logger.debug('Database token existence check completed', {
        requested: result.tokens.length,
        existingInDb: existingAddresses.size,
        newToInsert: result.tokens.length - existingAddresses.size,
        existingAddresses: Array.from(existingAddresses)
      });

      // ✅ STEP 2: Mark existing tokens as successful (for FK references)
      for (const token of result.tokens) {
        if (existingAddresses.has(token.address.toLowerCase())) {
          successfulTokenIds.add(token.id);
          logger.debug('Token already exists in database', {
            tokenId: token.id,
            address: token.address
          });
        }
      }

      // ✅ STEP 3: Insert only NEW tokens (those not in database)
      const newTokens = result.tokens.filter(t => !existingAddresses.has(t.address.toLowerCase()));
      
      if (newTokens.length > 0) {
        logger.debug('Inserting new tokens', {
          count: newTokens.length,
          addresses: newTokens.map(t => t.address)
        });
        
        await store.insert(newTokens);
        
        for (const token of newTokens) {
          successfulTokenIds.add(token.id);
        }
        
        logger.debug('✅ New tokens inserted successfully', { 
          count: newTokens.length
        });
      }

      logger.debug('✅ Token persistence completed successfully', { 
        total: result.tokens.length,
        existingInDb: existingAddresses.size,
        inserted: newTokens.length,
        successful: successfulTokenIds.size
      });
      
    } catch (error) {
      logger.error('❌ Failed to persist tokens', {
        count: result.tokens.length,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  // ✅ TokenTransfer persistence removed - now computed at runtime from logs

  /**
   * Calculate total number of entities to persist
   */
  private calculateTotalEntities(result: ProcessingResult): number {
    return result.blocks.length +
           result.transactions.length +
           result.accounts.size +
           result.logs.length +
           result.methodSignatures.size +
           result.tokens.length;
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
      tokens: result.tokens.length,
    };

    return {
      totalEntities: this.calculateTotalEntities(result),
      entityBreakdown,
    };
  }
} 