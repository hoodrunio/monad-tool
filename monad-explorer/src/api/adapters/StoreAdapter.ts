import { DataSource } from 'typeorm';
import { Transaction, Log, Block, TokenBalance } from '../../model/generated';
import { serviceContainer } from '../../services/core/ServiceContainer';
import { ITransactionService } from '../../interfaces/services/ITransactionService';
import { IInternalTransactionService } from '../../interfaces/services/IInternalTransactionService';

export interface StoreAdapter {
  Transaction: {
    findOne(options: any): Promise<Transaction | null>;
    find(options: any): Promise<Transaction[]>;
    findAndCount(options: any): Promise<[Transaction[], number]>;
  };
  Log: {
    find(options: any): Promise<Log[]>;
    findAndCount(options: any): Promise<[Log[], number]>;
  };
  Block: {
    findOne(options: any): Promise<Block | null>;
    find(options: any): Promise<Block[]>;
  };
  TokenBalance: {
    findOne(options: any): Promise<TokenBalance | null>;
    find(options: any): Promise<TokenBalance[]>;
  };
  
  // Service Resolution Methods
  getTransactionService(): Promise<ITransactionService>;
  getInternalTransactionService(): Promise<IInternalTransactionService>;
}

export function createStoreAdapter(dataSource: DataSource): StoreAdapter {
  const transactionRepo = dataSource.getRepository(Transaction);
  const logRepo = dataSource.getRepository(Log);
  const blockRepo = dataSource.getRepository(Block);
  const tokenBalanceRepo = dataSource.getRepository(TokenBalance);

  return {
    Transaction: {
      async findOne(options: any): Promise<Transaction | null> {
        try {
          const result = await transactionRepo.findOne({
            where: options.where,
            relations: options.relations || []
          });
          return result;
        } catch (error) {
          throw new Error(`Transaction findOne failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      },

      async find(options: any): Promise<Transaction[]> {
        try {
          const queryOptions: any = {};
          
          if (options.where) {
            queryOptions.where = options.where;
          }
          
          if (options.relations) {
            queryOptions.relations = options.relations;
          }
          
          if (options.order) {
            queryOptions.order = options.order;
          }
          
          if (options.skip !== undefined) {
            queryOptions.skip = options.skip;
          }
          
          if (options.take !== undefined) {
            queryOptions.take = options.take;
          }

          const result = await transactionRepo.find(queryOptions);
          return result;
        } catch (error) {
          throw new Error(`Transaction find failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      },

      async findAndCount(options: any): Promise<[Transaction[], number]> {
        try {
          const queryOptions: any = {};
          
          if (options.where) {
            queryOptions.where = options.where;
          }
          
          if (options.relations) {
            queryOptions.relations = options.relations;
          }
          
          if (options.order) {
            queryOptions.order = options.order;
          }
          
          if (options.skip !== undefined) {
            queryOptions.skip = options.skip;
          }
          
          if (options.take !== undefined) {
            queryOptions.take = options.take;
          }

          const result = await transactionRepo.findAndCount(queryOptions);
          return result;
        } catch (error) {
          throw new Error(`Transaction findAndCount failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    },

    Log: {
      async find(options: any): Promise<Log[]> {
        try {
          const queryOptions: any = {};
          
          if (options.where) {
            queryOptions.where = options.where;
          }
          
          if (options.relations) {
            queryOptions.relations = options.relations;
          }
          
          if (options.order) {
            queryOptions.order = options.order;
          }
          
          if (options.skip !== undefined) {
            queryOptions.skip = options.skip;
          }
          
          if (options.take !== undefined) {
            queryOptions.take = options.take;
          }

          const result = await logRepo.find(queryOptions);
          return result;
        } catch (error) {
          throw new Error(`Log find failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      },

      async findAndCount(options: any): Promise<[Log[], number]> {
        try {
          const queryOptions: any = {};
          
          if (options.where) {
            queryOptions.where = options.where;
          }
          
          if (options.relations) {
            queryOptions.relations = options.relations;
          }
          
          if (options.order) {
            queryOptions.order = options.order;
          }
          
          if (options.skip !== undefined) {
            queryOptions.skip = options.skip;
          }
          
          if (options.take !== undefined) {
            queryOptions.take = options.take;
          }

          const result = await logRepo.findAndCount(queryOptions);
          return result;
        } catch (error) {
          throw new Error(`Log findAndCount failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    },

    Block: {
      async findOne(options: any): Promise<Block | null> {
        try {
          const result = await blockRepo.findOne({
            where: options.where,
            relations: options.relations || []
          });
          return result;
        } catch (error) {
          throw new Error(`Block findOne failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      },

      async find(options: any): Promise<Block[]> {
        try {
          const queryOptions: any = {};
          
          if (options.where) {
            queryOptions.where = options.where;
          }
          
          if (options.relations) {
            queryOptions.relations = options.relations;
          }
          
          if (options.order) {
            queryOptions.order = options.order;
          }
          
          if (options.skip !== undefined) {
            queryOptions.skip = options.skip;
          }
          
          if (options.take !== undefined) {
            queryOptions.take = options.take;
          }

          const result = await blockRepo.find(queryOptions);
          return result;
        } catch (error) {
          throw new Error(`Block find failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    },

    TokenBalance: {
      async findOne(options: any): Promise<TokenBalance | null> {
        try {
          const result = await tokenBalanceRepo.findOne({
            where: options.where,
            relations: options.relations || []
          });
          return result;
        } catch (error) {
          throw new Error(`TokenBalance findOne failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      },

      async find(options: any): Promise<TokenBalance[]> {
        try {
          const queryOptions: any = {};
          
          if (options.where) {
            queryOptions.where = options.where;
          }
          
          if (options.relations) {
            queryOptions.relations = options.relations;
          }
          
          if (options.order) {
            queryOptions.order = options.order;
          }
          
          if (options.skip !== undefined) {
            queryOptions.skip = options.skip;
          }
          
          if (options.take !== undefined) {
            queryOptions.take = options.take;
          }

          const result = await tokenBalanceRepo.find(queryOptions);
          return result;
        } catch (error) {
          throw new Error(`TokenBalance find failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    },

    // Service Resolution Methods
    async getTransactionService(): Promise<ITransactionService> {
      const transactionServiceFactory = await serviceContainer.resolve<any>('transactionServiceFactory');
      return await transactionServiceFactory.create(this);
    },

    async getInternalTransactionService(): Promise<IInternalTransactionService> {
      const internalTransactionServiceFactory = await serviceContainer.resolve<any>('internalTransactionServiceFactory');
      return await internalTransactionServiceFactory.create(this);
    }
  };
} 