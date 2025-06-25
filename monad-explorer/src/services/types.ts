// Token metadata types
export interface TokenMetadata {
  name: string
  symbol: string
  decimals: number
  totalSupply: bigint
  tokenType: 'ERC20' | 'ERC721' | 'ERC1155' | 'UNKNOWN'
}

// Internal transaction types
export interface InternalTransactionTrace {
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

// API response types
export interface TokenEnrichmentResponse {
  success: boolean
  tokensProcessed: number
  errors?: string[]
}

export interface InternalTxResponse {
  transactionHash: string
  internalTransactions: InternalTransactionTrace[]
  status: 'found' | 'tracing' | 'not_found' | 'error'
  cached: boolean
}

// Service configuration following Interface Segregation Principle
export interface ServiceConfig {
  rpcUrl: string
  redisUrl?: string
  batchSize: number
  rateLimit: number
  cacheTimeout: number
}

// Database configuration (separate from service config)
export interface DatabaseConfig {
  storeInstance?: any // TypeORM store instance from Subsquid context
}

// Cache configuration (separate from service config)
export interface CacheConfig {
  redisUrl?: string
  defaultTtl: number
  keyPrefix: string
}

// Blockchain provider configuration
export interface BlockchainConfig {
  rpcUrl: string
  multicallAddress?: string
  rateLimit: number
  timeout: number
}

// Background job types
export interface TokenEnrichmentJob {
  tokenAddresses: string[]
  priority: 'high' | 'normal' | 'low'
  retryCount: number
}

export interface InternalTxJob {
  transactionHash: string
  requestId: string
  priority: 'high' | 'normal'
}

// Strategy configuration
export interface StrategyConfig {
  enabled: boolean
  priority: number
  options?: Record<string, any>
}

// Complete service configuration that combines all configs
export interface CompleteServiceConfig {
  service: ServiceConfig
  database?: DatabaseConfig
  cache?: CacheConfig
  blockchain?: BlockchainConfig
  strategies?: Record<string, StrategyConfig>
}

// Error types for better error handling
export interface ServiceError {
  code: string
  message: string
  details?: any
  timestamp: Date
}

// Metrics types for monitoring
export interface ServiceMetrics {
  tokensEnriched: number
  transactionsTraced: number
  cacheHits: number
  cacheMisses: number
  errors: number
  lastUpdated: Date
} 