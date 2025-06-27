import { logger } from '../utils/logger';

export interface DatabaseConfig {
  supportHotBlocks: boolean;
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
}

export interface QueueConfig {
  rabbitMqUrl: string;
  exchange: string;
  queues: {
    tokenEnrichment: string;
    internalTransactions: string;
    deadLetter: string;
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

export interface AppConfig {
  database: DatabaseConfig;
  rpc: RpcConfig;
  processor: ProcessorConfig;
  queue: QueueConfig;
  worker: WorkerConfig;
  cache: CacheConfig;
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
      },
      queue: {
        rabbitMqUrl,
        exchange: this.getStringEnv('QUEUE_EXCHANGE', 'monad-explorer'),
        queues: {
          tokenEnrichment: this.getStringEnv('QUEUE_TOKEN_ENRICHMENT', 'token-enrichment'),
          internalTransactions: this.getStringEnv('QUEUE_INTERNAL_TRANSACTIONS', 'internal-transactions'),
          deadLetter: this.getStringEnv('QUEUE_DEAD_LETTER', 'dead-letter'),
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