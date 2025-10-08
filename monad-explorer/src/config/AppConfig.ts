import { logger } from '../utils/logger';

export interface DatabaseConfig {
  supportHotBlocks: boolean;
  // Performance optimization settings
  maxConnections: number;
  idleTimeoutMillis: number;
  statementTimeout: number; // PostgreSQL statement timeout in ms
  // Batch processing settings
  chunkSize: number; // Number of entities per chunk for bulk inserts
  maxConcurrency: number; // Max concurrent chunk processing
}

export interface RpcConfig {
  url: string;
  rateLimit: number;
  capacity: number;
  requestTimeout: number;
  maxBatchCallSize: number;
}

export interface ProcessorConfig {
  finalityConfirmation: number;
  startBlock: number;
  enableTokenEnrichment: boolean;
  enableAsyncProcessing: boolean;
  enableContractDiscovery: boolean;
}

export interface QueueConfig {
  rabbitMqUrl: string;
  exchange: string;
  queues: {
    tokenEnrichment: string;
    contractEnrichment: string;
    transactionEnrichment: string;
    dailyStats: string;
    //internalTransactions: string;
    deadLetter: string;
    coldStorage: string;
  };
  maxRetries: number;
  retryDelay: number;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  prefetchCount: number;
  messageTtl: number;
}

export interface WorkerConfig {
  maxConcurrentJobs: number;
  retryAttempts: number;
  retryDelay: number;
  healthCheckInterval: number;
}

export interface CacheConfig {
  type: 'redis' | 'memory';
  defaultTtl: number;
  maxSize: number;
  enableMetrics: boolean;
  redis?: {
    host: string;
    port: number;
    password?: string;
    db: number;
    keyPrefix: string;
    maxRetries: number;
    retryDelayOnFailover: number;
    enableReadyCheck: boolean;
    connectTimeout: number;
    commandTimeout: number;
  };
}

export type StorageRoutingMode = 'hot-only' | 'dual-write' | 'cold-primary';

export interface StorageConfig {
  enableColdStorage: boolean;
  enableColdReads: boolean;
  enableHotPruning: boolean;
  routingMode: StorageRoutingMode;
  hotBlockWindow: number;
  hotRetentionDays: number;
  coldQueue: string;
  coldBatchSize: number;
  coldReadOffsetThreshold: number;
  ingestion: {
    workerConcurrency: number;
    queuePrefetch: number;
  };
  clickHouse: {
    url: string;
    database: string;
    username: string;
    password?: string;
    compression: boolean;
    requestTimeoutMs: number;
    maxInsertBatchSize: number;
    tables: {
      blocks: string;
      transactions: string;
      logs: string;
    };
      };
  pruner: {
    dryRun: boolean;
    batchSize: number;
    runIntervalMinutes: number;
    safetyBufferHours: number;
  };
}

export interface AppConfig {
  database: DatabaseConfig;
  rpc: RpcConfig;
  processor: ProcessorConfig;
  queue: QueueConfig;
  worker: WorkerConfig;
  cache: CacheConfig;
  storage: StorageConfig;
  isDevelopment: boolean;
  isProduction: boolean;
}

class ConfigManager {
  private static instance: ConfigManager;
  private config: AppConfig;

  private constructor() {
    this.config = this.loadAndValidateConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  public getConfig(): AppConfig {
    return this.config;
  }

  private loadAndValidateConfig(): AppConfig {
    const nodeEnv = process.env.NODE_ENV || 'development';
    const isDevelopment = nodeEnv === 'development';
    const isProduction = nodeEnv === 'production';

    // Validate required environment variables
    const rpcUrl = this.requireEnvVar('RPC_MONAD_HTTP', 'https://testnet-rpc.monad.xyz');
    const rabbitMqUrl = this.requireEnvVar('RABBITMQ_URL', 'amqp://localhost:5672');

    const config: AppConfig = {
      database: {
        supportHotBlocks: this.getBooleanEnv('ENABLE_HOT_BLOCKS', true),
        // Optimized connection pool settings for high-throughput processing
        maxConnections: this.getNumberEnv('DB_MAX_CONNECTIONS', 20),
        idleTimeoutMillis: this.getNumberEnv('DB_IDLE_TIMEOUT', 30000),
        statementTimeout: this.getNumberEnv('DB_STATEMENT_TIMEOUT', 60000),
        // Batch processing optimization
        chunkSize: this.getNumberEnv('DB_CHUNK_SIZE', 5000),
        maxConcurrency: this.getNumberEnv('DB_MAX_CONCURRENCY', 6),
      },
      rpc: {
        url: rpcUrl,
        rateLimit: this.getNumberEnv('RPC_RATE_LIMIT', 50),
        capacity: this.getNumberEnv('RPC_CAPACITY', 100),
        requestTimeout: this.getNumberEnv('RPC_REQUEST_TIMEOUT', 30000),
        maxBatchCallSize: this.getNumberEnv('RPC_MAX_BATCH_CALL_SIZE', 100),
      },
      processor: {
        finalityConfirmation: this.getNumberEnv('FINALITY_CONFIRMATION', 2),
        startBlock: this.getNumberEnv('START_BLOCK', 23460742),
        enableTokenEnrichment: this.getBooleanEnv('ENABLE_TOKEN_ENRICHMENT', true),
        enableAsyncProcessing: this.getBooleanEnv('ENABLE_ASYNC_PROCESSING', false),
        enableContractDiscovery: this.getBooleanEnv('ENABLE_CONTRACT_DISCOVERY', true),
      },
      queue: {
        rabbitMqUrl,
        exchange: this.getStringEnv('QUEUE_EXCHANGE', 'monad-explorer'),
        queues: {
          tokenEnrichment: this.getStringEnv('QUEUE_TOKEN_ENRICHMENT', 'token-enrichment'),
          contractEnrichment: this.getStringEnv('QUEUE_CONTRACT_ENRICHMENT', 'contract-enrichment'),
          transactionEnrichment: this.getStringEnv('QUEUE_TRANSACTION_ENRICHMENT', 'transaction-enrichment'),
          dailyStats: this.getStringEnv('QUEUE_DAILY_STATS', 'daily-stats'),
          //internalTransactions: this.getStringEnv('QUEUE_INTERNAL_TRANSACTIONS', 'internal-transactions'),
          deadLetter: this.getStringEnv('QUEUE_DEAD_LETTER', 'dead-letter'),
          coldStorage: this.getStringEnv('QUEUE_COLD_STORAGE', 'cold-storage-ingest'),
        },
        maxRetries: this.getNumberEnv('QUEUE_MAX_RETRIES', 3),
        retryDelay: this.getNumberEnv('QUEUE_RETRY_DELAY', 30000),
        maxReconnectAttempts: this.getNumberEnv('QUEUE_MAX_RECONNECT_ATTEMPTS', 10),
        reconnectDelay: this.getNumberEnv('QUEUE_RECONNECT_DELAY', 5000),
        prefetchCount: this.getNumberEnv('QUEUE_PREFETCH_COUNT', 10),
        messageTtl: this.getNumberEnv('QUEUE_MESSAGE_TTL', 7 * 24 * 60 * 60 * 1000), // 7 days
      },
      worker: {
        maxConcurrentJobs: this.getNumberEnv('MAX_CONCURRENT_JOBS', 3),
        retryAttempts: this.getNumberEnv('RETRY_ATTEMPTS', 3),
        retryDelay: this.getNumberEnv('RETRY_DELAY', 1000),
        healthCheckInterval: this.getNumberEnv('HEALTH_CHECK_INTERVAL', 30000),
      },
      cache: {
        type: this.getStringEnv('CACHE_TYPE', 'redis') as 'redis' | 'memory',
        defaultTtl: this.getNumberEnv('CACHE_DEFAULT_TTL', 300000), // 5 minutes
        maxSize: this.getNumberEnv('CACHE_MAX_SIZE', 10000),
        enableMetrics: this.getBooleanEnv('CACHE_ENABLE_METRICS', true),
        redis: {
          host: this.getStringEnv('REDIS_HOST', 'localhost'),
          port: this.getNumberEnv('REDIS_PORT', 6379),
          password: process.env.REDIS_PASSWORD,
          db: this.getNumberEnv('REDIS_DB', 0),
          keyPrefix: this.getStringEnv('REDIS_KEY_PREFIX', 'monad:'),
          maxRetries: this.getNumberEnv('REDIS_MAX_RETRIES', 3),
          retryDelayOnFailover: this.getNumberEnv('REDIS_RETRY_DELAY', 100),
          enableReadyCheck: this.getBooleanEnv('REDIS_ENABLE_READY_CHECK', true),
          connectTimeout: this.getNumberEnv('REDIS_CONNECT_TIMEOUT', 10000),
          commandTimeout: this.getNumberEnv('REDIS_COMMAND_TIMEOUT', 5000),
        },
      },
      storage: {
        enableColdStorage: this.getBooleanEnv('ENABLE_COLD_STORAGE', false),
        enableColdReads: this.getBooleanEnv('ENABLE_COLD_READS', true),
        enableHotPruning: this.getBooleanEnv('ENABLE_HOT_PRUNING', false),
        routingMode: this.getStorageRoutingMode('STORAGE_ROUTING_MODE', 'hot-only'),
        hotBlockWindow: this.getNumberEnv('HOT_BLOCK_WINDOW', 4096),
        hotRetentionDays: this.getNumberEnv('HOT_RETENTION_DAYS', 7),
        coldQueue: this.getStringEnv('COLD_STORAGE_QUEUE', 'cold-storage-ingest'),
        coldBatchSize: this.getNumberEnv('COLD_STORAGE_BATCH_SIZE', 5000),
        coldReadOffsetThreshold: this.getNumberEnv('COLD_READ_OFFSET_THRESHOLD', 50000),
        ingestion: {
          workerConcurrency: this.getNumberEnv('COLD_STORAGE_WORKER_CONCURRENCY', 4),
          queuePrefetch: this.getNumberEnv('COLD_STORAGE_QUEUE_PREFETCH', 8),
        },
        clickHouse: {
          url: this.getStringEnv('CLICKHOUSE_URL', 'http://localhost:8123'),
          database: this.getStringEnv('CLICKHOUSE_DATABASE', 'monad_explorer'),
          username: this.getStringEnv('CLICKHOUSE_USER', 'default'),
          password: process.env.CLICKHOUSE_PASSWORD,
          compression: this.getBooleanEnv('CLICKHOUSE_COMPRESSION', true),
          requestTimeoutMs: this.getNumberEnv('CLICKHOUSE_REQUEST_TIMEOUT_MS', 30000),
          maxInsertBatchSize: this.getNumberEnv('CLICKHOUSE_MAX_INSERT_BATCH_SIZE', 10000),
          tables: {
            blocks: this.getStringEnv('CLICKHOUSE_BLOCKS_TABLE', 'blocks_cold'),
            transactions: this.getStringEnv('CLICKHOUSE_TRANSACTIONS_TABLE', 'transactions_cold'),
            logs: this.getStringEnv('CLICKHOUSE_LOGS_TABLE', 'logs_cold'),
          },
        },
        pruner: {
          dryRun: this.getBooleanEnv('HOT_PRUNER_DRY_RUN', true),
          batchSize: this.getNumberEnv('HOT_PRUNER_BATCH_SIZE', 5000),
          runIntervalMinutes: this.getNumberEnv('HOT_PRUNER_RUN_INTERVAL_MINUTES', 30),
          safetyBufferHours: this.getNumberEnv('HOT_PRUNER_SAFETY_BUFFER_HOURS', 6),
        },
      },
      isDevelopment,
      isProduction,
    };

    this.validateConfig(config);
    this.logConfig(config);

    return config;
  }

  private requireEnvVar(key: string, defaultValue?: string): string {
    const value = process.env[key] || defaultValue;
    if (!value) {
      throw new Error(`Required environment variable ${key} is not set`);
    }
    return value;
  }

  private getStringEnv(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
  }

  private getNumberEnv(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (!value) return defaultValue;
    
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      logger.warn(`Invalid number value for ${key}: ${value}, using default: ${defaultValue}`);
      return defaultValue;
    }
    return parsed;
  }

  private getBooleanEnv(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (!value) return defaultValue;
    
    return value.toLowerCase() === 'true';
  }

  private getStorageRoutingMode(key: string, defaultValue: StorageRoutingMode): StorageRoutingMode {
    const value = process.env[key];
    if (!value) {
      return defaultValue;
    }

    const normalized = value.toLowerCase();
    if (normalized === 'hot-only' || normalized === 'dual-write' || normalized === 'cold-primary') {
      return normalized;
    }

    logger.warn(`Invalid storage routing mode value for ${key}: ${value}, using default: ${defaultValue}`);
    return defaultValue;
  }

  private validateConfig(config: AppConfig): void {
    // Validate RPC URL
    try {
      new URL(config.rpc.url);
    } catch {
      throw new Error(`Invalid RPC URL: ${config.rpc.url}`);
    }

    // Validate numeric ranges
    if (config.rpc.rateLimit <= 0) {
      throw new Error('RPC rate limit must be positive');
    }

    if (config.processor.startBlock < 0) {
      throw new Error('Start block must be non-negative');
    }

    if (config.worker.maxConcurrentJobs <= 0) {
      throw new Error('Max concurrent jobs must be positive');
    }

    // Validate queue names
    const queueNames = Object.values(config.queue.queues);
    if (queueNames.some(name => !name || name.trim().length === 0)) {
      throw new Error('All queue names must be non-empty strings');
    }

    const allowedRoutingModes: StorageRoutingMode[] = ['hot-only', 'dual-write', 'cold-primary'];
    if (!allowedRoutingModes.includes(config.storage.routingMode)) {
      throw new Error(`Invalid storage routing mode: ${config.storage.routingMode}`);
    }

    if (config.storage.hotBlockWindow <= 0) {
      throw new Error('Hot block window must be positive');
    }

    if (config.storage.coldReadOffsetThreshold < 0) {
      throw new Error('Cold read offset threshold must be non-negative');
    }

    if (config.storage.hotRetentionDays <= 0) {
      throw new Error('Hot retention days must be positive');
    }

    if (config.storage.coldBatchSize <= 0) {
      throw new Error('Cold storage batch size must be positive');
    }

    if (!config.storage.coldQueue || config.storage.coldQueue.trim().length === 0) {
      throw new Error('Cold storage queue name must be specified');
    }

    if (config.storage.pruner.batchSize <= 0) {
      throw new Error('Hot storage pruner batch size must be positive');
    }

    if (config.storage.pruner.runIntervalMinutes <= 0) {
      throw new Error('Hot storage pruner run interval must be positive');
    }

    if (config.storage.pruner.safetyBufferHours < 0) {
      throw new Error('Hot storage pruner safety buffer cannot be negative');
    }

    if (config.storage.ingestion.workerConcurrency <= 0) {
      throw new Error('Cold storage worker concurrency must be positive');
    }

    if (config.storage.ingestion.queuePrefetch <= 0) {
      throw new Error('Cold storage queue prefetch must be positive');
    }

    if (!config.storage.clickHouse.url) {
      throw new Error('ClickHouse URL must be specified');
    }

    if (!config.storage.clickHouse.database) {
      throw new Error('ClickHouse database must be specified');
    }

    if (config.storage.clickHouse.maxInsertBatchSize <= 0) {
      throw new Error('ClickHouse max insert batch size must be positive');
    }

    const clickHouseTables = config.storage.clickHouse.tables;
    if (!clickHouseTables.blocks || !clickHouseTables.transactions || !clickHouseTables.logs) {
      throw new Error('ClickHouse table names must be specified');
    }

    logger.info('Configuration validation completed successfully');
  }

  private logConfig(config: AppConfig): void {
    // Log configuration without sensitive data
    const safeConfig = {
      ...config,
      queue: {
        ...config.queue,
        rabbitMqUrl: this.maskSensitiveUrl(config.queue.rabbitMqUrl),
      },
      rpc: {
        ...config.rpc,
        url: config.rpc.url.includes('localhost') ? config.rpc.url : this.maskSensitiveUrl(config.rpc.url),
      },
      storage: {
        ...config.storage,
        clickHouse: {
          ...config.storage.clickHouse,
          password: config.storage.clickHouse.password ? '***masked***' : undefined,
        },
        pruner: {
          ...config.storage.pruner,
          dryRun: config.storage.pruner.dryRun,
        },
      },
    };

    logger.info('Application configuration loaded', { config: safeConfig });
  }

  private maskSensitiveUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      if (urlObj.username || urlObj.password) {
        return `${urlObj.protocol}//***.***@${urlObj.host}${urlObj.pathname}`;
      }
      return url;
    } catch {
      return '***masked***';
    }
  }
}

// Export singleton instance
export const appConfig = ConfigManager.getInstance();
export default appConfig; 
