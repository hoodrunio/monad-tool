// Type-safe configuration management with Zod validation
// Ensures all required environment variables are present and valid at startup

import { z } from 'zod';
import { logger } from '../utils/logger';

/**
 * Configuration schema with validation rules
 */
const ConfigSchema = z.object({
  // Network Configuration
  VALIDATOR_NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).default('testnet'),
  MONAD_RPC_URL: z.string().url().default('http://localhost:8080'),

  // Database Configuration
  DATABASE_HOST: z.string().default('localhost'),
  DATABASE_PORT: z.coerce.number().int().positive().default(9000),
  DATABASE_USER: z.string().default('default'),
  DATABASE_PASSWORD: z.string().default(''),
  DATABASE_NAME: z.string().default('monad_validator_analytics'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(10),
  DATABASE_QUERY_TIMEOUT: z.coerce.number().int().positive().default(30000),
  DATABASE_COMPRESSION: z.coerce.boolean().default(true),

  // Redis Configuration
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  // API Server Configuration
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Staking Contract Configuration
  STAKING_CONTRACT_ADDRESS: z.string().optional(),
  CONSENSUS_CONTRACT_ADDRESS: z.string().optional(),

  // Cache Configuration
  CACHE_ENABLED: z.coerce.boolean().default(true),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Logging Configuration
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Optional Features
  ENABLE_METRICS: z.coerce.boolean().default(true),
  ENABLE_DNS_LOOKUP: z.coerce.boolean().default(true),
});

/**
 * Inferred TypeScript type from schema
 */
export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Validated configuration singleton
 */
class ConfigManager {
  private static instance: ConfigManager;
  private config: AppConfig | null = null;

  private constructor() {}

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Validate and load configuration from environment variables.
   * Must be called once at application startup.
   *
   * @throws {Error} If validation fails or required env vars are missing
   */
  validate(): void {
    try {
      logger.info('Validating application configuration...');

      const parsed = ConfigSchema.safeParse(process.env);

      if (!parsed.success) {
        const errors = parsed.error.format();
        logger.error('Configuration validation failed:', errors);
        throw new Error(`Configuration validation failed: ${JSON.stringify(errors, null, 2)}`);
      }

      this.config = parsed.data;
      logger.info('✅ Configuration validated successfully');

      // Log non-sensitive config for debugging
      this.logConfiguration();
    } catch (error) {
      logger.error('Failed to validate configuration:', error);
      throw error;
    }
  }

  /**
   * Get validated configuration.
   * @throws {Error} If configuration hasn't been validated yet
   */
  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('Configuration not initialized. Call validate() first.');
    }
    return this.config;
  }

  /**
   * Log configuration (excluding sensitive data)
   */
  private logConfiguration(): void {
    if (!this.config) return;

    const safeConfig = {
      network: this.config.VALIDATOR_NETWORK,
      rpcUrl: this.config.MONAD_RPC_URL,
      database: {
        host: this.config.DATABASE_HOST,
        port: this.config.DATABASE_PORT,
        name: this.config.DATABASE_NAME,
        user: this.config.DATABASE_USER,
        // password: '***REDACTED***',
      },
      redis: {
        host: this.config.REDIS_HOST,
        port: this.config.REDIS_PORT,
        db: this.config.REDIS_DB,
      },
      server: {
        port: this.config.PORT,
        env: this.config.NODE_ENV,
      },
      features: {
        cacheEnabled: this.config.CACHE_ENABLED,
        metricsEnabled: this.config.ENABLE_METRICS,
        dnsLookup: this.config.ENABLE_DNS_LOOKUP,
      },
    };

    logger.debug('Application configuration:', safeConfig);
  }

  /**
   * Get a specific config value with type safety
   */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.getConfig()[key];
  }

  /**
   * Check if configuration is initialized
   */
  isInitialized(): boolean {
    return this.config !== null;
  }
}

// Export singleton instance
export const configManager = ConfigManager.getInstance();

/**
 * Helper functions for easy access to config values
 */
export const getConfig = (): AppConfig => configManager.getConfig();
export const getConfigValue = <K extends keyof AppConfig>(key: K): AppConfig[K] => configManager.get(key);

/**
 * Validate configuration at startup
 * Call this once in your main application entry point
 */
export const validateConfig = (): void => configManager.validate();

/**
 * Check if config is initialized
 */
export const isConfigInitialized = (): boolean => configManager.isInitialized();
