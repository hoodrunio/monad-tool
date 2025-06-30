import axios, { AxiosInstance, AxiosError } from 'axios';
import { IRpcClient, RpcCallOptions, ContractCallOptions, TraceOptions } from '../../interfaces/blockchain/IRpcClient';
import { RpcConfig } from '../../config/AppConfig';
import { logger } from '../../utils/logger';

export interface RpcMetrics {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  averageResponseTime: number;
  lastSuccessfulCall: Date | null;
  circuitBreakerOpen: boolean;
}

export class RpcClient implements IRpcClient {
  private readonly config: RpcConfig;
  private readonly client: AxiosInstance;
  private readonly metrics: RpcMetrics;
  private circuitBreakerFailureCount = 0;
  private circuitBreakerLastFailure: Date | null = null;
  private readonly circuitBreakerThreshold = 5;
  private readonly circuitBreakerTimeout = 30000; // 30 seconds

  constructor(config: RpcConfig) {
    this.config = config;
    this.metrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      averageResponseTime: 0,
      lastSuccessfulCall: null,
      circuitBreakerOpen: false,
    };

    this.client = axios.create({
      baseURL: config.url,
      timeout: config.requestTimeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Monad-Explorer-RPC-Client/1.0',
      },
      // Axios rate limiting
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    this.setupInterceptors();
  }

  public async call<T = unknown>(
    method: string,
    params: unknown[] = [],
    options: RpcCallOptions = {}
  ): Promise<T> {
    if (this.isCircuitBreakerOpen()) {
      throw new Error('Circuit breaker is open. RPC calls temporarily disabled.');
    }

    const startTime = Date.now();
    const retries = options.retries || 3;
    const timeout = options.timeout || this.config.requestTimeout;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        this.metrics.totalCalls++;

        const payload = {
          jsonrpc: '2.0',
          method,
          params,
          id: this.generateRequestId(),
        };

        /* logger.debug('Making RPC call', {
          method,
          params: this.sanitizeParams(params),
          attempt: attempt + 1,
          timeout,
        }); */

        const response = await this.client.post('', payload, {
          timeout,
          signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
        });

        if (response.data.error) {
          const errorCode = response.data.error.code;
          const errorMessage = response.data.error.message;
          
          // Don't retry "execution reverted" - it's a normal contract response
          const isExecutionReverted = errorCode === -32603 && errorMessage.includes('execution reverted');
          
          const error = new Error(`RPC Error: ${errorMessage} (Code: ${errorCode})`);
          (error as any).code = errorCode;
          (error as any).isRetryable = !isExecutionReverted; // execution reverted = not retryable
          
          throw error;
        }

        const responseTime = Date.now() - startTime;
        this.recordSuccess(responseTime);

/*         logger.debug('RPC call successful', {
          method,
          responseTime,
          attempt: attempt + 1,
        }); */

        return response.data.result as T;

      } catch (error) {
        const isLastAttempt = attempt === retries;
        const responseTime = Date.now() - startTime;
        const isRetryable = (error as any).isRetryable !== false;
        const isExecutionReverted = error instanceof Error && error.message.includes('execution reverted');

        if (isLastAttempt || !isRetryable) {
          // Only record as failure if it's not an execution reverted error
          if (!isExecutionReverted) {
            this.recordFailure();
          }
          
          // Log execution reverted as debug, real errors as error
          if (isExecutionReverted) {
            logger.debug('Contract method not implemented (normal behavior)', {
              method,
              params: this.sanitizeParams(params),
              attempts: attempt + 1,
              message: error instanceof Error ? error.message : 'Unknown error',
              responseTime,
            });
          } else {
            logger.error('RPC call failed after all retries', {
              method,
              params: this.sanitizeParams(params),
              attempts: attempt + 1,
              error: error instanceof Error ? error.message : 'Unknown error',
              responseTime,
            });
          }
          
          throw this.enhanceError(error, method, params);
        } else {
          const delay = this.calculateRetryDelay(attempt);
          logger.debug('RPC call failed, retrying', {
            method,
            attempt: attempt + 1,
            totalAttempts: retries + 1,
            retryDelay: delay,
            retryable: isRetryable,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          await this.sleep(delay);
        }
      }
    }

    throw new Error('Unexpected end of retry loop'); // Should never reach here
  }

  public async getCode(address: string, blockTag: string | number = 'latest'): Promise<string> {
    const blockTagHex = typeof blockTag === 'number' ? `0x${blockTag.toString(16)}` : blockTag;
    return this.call<string>('eth_getCode', [address, blockTagHex]);
  }

  public async callContract<T = unknown>(
    to: string,
    data: string,
    options: ContractCallOptions = {}
  ): Promise<T> {
    const callParams: Record<string, unknown> = { to, data };
    
    if (options.from) callParams.from = options.from;
    if (options.gas) callParams.gas = options.gas;
    if (options.gasPrice) callParams.gasPrice = options.gasPrice;

    const blockTag = options.blockTag || 'latest';
    const blockTagHex = typeof blockTag === 'number' ? `0x${blockTag.toString(16)}` : blockTag;

    return this.call<T>('eth_call', [callParams, blockTagHex], options);
  }

  public async getBlockNumber(): Promise<number> {
    const result = await this.call<string>('eth_blockNumber');
    return parseInt(result, 16);
  }

  public async getBlock(blockHashOrNumber: string | number, includeTransactions = false): Promise<unknown> {
    const blockId = typeof blockHashOrNumber === 'number' 
      ? `0x${blockHashOrNumber.toString(16)}` 
      : blockHashOrNumber;
    
    return this.call('eth_getBlockByHash', [blockId, includeTransactions]);
  }

  public async getTransaction(hash: string): Promise<unknown> {
    return this.call('eth_getTransactionByHash', [hash]);
  }

  public async getTransactionReceipt(hash: string): Promise<unknown> {
    return this.call('eth_getTransactionReceipt', [hash]);
  }

  public async traceTransaction(hash: string, options: TraceOptions = {}): Promise<unknown> {
    const traceConfig = {
      tracer: options.tracer || 'callTracer',
      timeout: options.timeout || '60s',
      disableMemory: options.disableMemory !== false,
      disableStack: options.disableStack !== false,
      disableStorage: options.disableStorage !== false,
      enableMemory: options.enableMemory === true,
      enableReturnData: options.enableReturnData !== false,
    };

    return this.call('debug_traceTransaction', [hash, traceConfig]);
  }

  public async isHealthy(): Promise<boolean> {
    try {
      await this.call('eth_blockNumber', [], { timeout: 5000, retries: 1 });
      return true;
    } catch {
      return false;
    }
  }

  public getConnectionStatus() {
    return {
      connected: !this.isCircuitBreakerOpen(),
      lastSuccessfulCall: this.metrics.lastSuccessfulCall,
      errorCount: this.metrics.failedCalls,
    };
  }

  public getMetrics(): RpcMetrics {
    return { ...this.metrics };
  }

  public resetMetrics(): void {
    this.metrics.totalCalls = 0;
    this.metrics.successfulCalls = 0;
    this.metrics.failedCalls = 0;
    this.metrics.averageResponseTime = 0;
    this.circuitBreakerFailureCount = 0;
    this.circuitBreakerLastFailure = null;
    this.metrics.circuitBreakerOpen = false;
  }

  private setupInterceptors(): void {
    // Request interceptor for rate limiting
    this.client.interceptors.request.use(
      async (config) => {
        // Simple rate limiting implementation
        await this.enforceRateLimit();
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        /* logger.debug('HTTP response received', {
          status: response.status,
          statusText: response.statusText,
        }); */
        return response;
      },
      (error: AxiosError) => {
        logger.debug('HTTP request failed', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          message: error.message,
        });
        return Promise.reject(error);
      }
    );
  }

  private async enforceRateLimit(): Promise<void> {
    // Simple token bucket rate limiting
    const now = Date.now();
    const timeSinceLastCall = now - (this.lastCallTime || 0);
    const minInterval = 1000 / this.config.rateLimit; // ms between calls

    if (timeSinceLastCall < minInterval) {
      const delay = minInterval - timeSinceLastCall;
      await this.sleep(delay);
    }

    this.lastCallTime = now;
  }

  private lastCallTime = 0;

  private recordSuccess(responseTime: number): void {
    this.metrics.successfulCalls++;
    this.metrics.lastSuccessfulCall = new Date();
    this.updateAverageResponseTime(responseTime);
    this.resetCircuitBreaker();
  }

  private recordFailure(): void {
    this.metrics.failedCalls++;
    this.circuitBreakerFailureCount++;
    this.circuitBreakerLastFailure = new Date();
    this.updateCircuitBreakerState();
  }

  private updateAverageResponseTime(responseTime: number): void {
    const totalSuccessful = this.metrics.successfulCalls;
    this.metrics.averageResponseTime = 
      (this.metrics.averageResponseTime * (totalSuccessful - 1) + responseTime) / totalSuccessful;
  }

  private isCircuitBreakerOpen(): boolean {
    if (!this.circuitBreakerLastFailure) return false;

    const timeSinceLastFailure = Date.now() - this.circuitBreakerLastFailure.getTime();
    
    if (timeSinceLastFailure > this.circuitBreakerTimeout) {
      // Reset circuit breaker after timeout
      this.resetCircuitBreaker();
      return false;
    }

    return this.circuitBreakerFailureCount >= this.circuitBreakerThreshold;
  }

  private updateCircuitBreakerState(): void {
    this.metrics.circuitBreakerOpen = this.isCircuitBreakerOpen();
    
    if (this.metrics.circuitBreakerOpen) {
      logger.warn('Circuit breaker opened due to excessive failures', {
        failureCount: this.circuitBreakerFailureCount,
        threshold: this.circuitBreakerThreshold,
        timeoutMs: this.circuitBreakerTimeout,
      });
    }
  }

  private resetCircuitBreaker(): void {
    if (this.circuitBreakerFailureCount > 0) {
      logger.info('Circuit breaker reset after successful call');
    }
    this.circuitBreakerFailureCount = 0;
    this.circuitBreakerLastFailure = null;
    this.metrics.circuitBreakerOpen = false;
  }

  private calculateRetryDelay(attempt: number): number {
    // Exponential backoff with jitter
    const baseDelay = 1000; // 1 second
    const maxDelay = 10000; // 10 seconds
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
    return exponentialDelay + jitter;
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private sanitizeParams(params: unknown[]): unknown[] {
    // Remove sensitive data from logs
    return params.map(param => {
      if (typeof param === 'string' && param.length > 100) {
        return `${param.substring(0, 50)}...truncated`;
      }
      return param;
    });
  }

  private enhanceError(error: unknown, method: string, params: unknown[]): Error {
    const baseMessage = error instanceof Error ? error.message : 'Unknown RPC error';
    const enhancedMessage = `RPC call failed - Method: ${method}, Error: ${baseMessage}`;
    
    const enhancedError = new Error(enhancedMessage);
    (enhancedError as any).originalError = error;
    (enhancedError as any).method = method;
    (enhancedError as any).params = this.sanitizeParams(params);
    (enhancedError as any).metrics = this.getMetrics();
    
    return enhancedError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public async dispose(): Promise<void> {
    logger.info('Disposing RPC client', {
      totalCalls: this.metrics.totalCalls,
      successRate: this.metrics.totalCalls > 0 
        ? (this.metrics.successfulCalls / this.metrics.totalCalls * 100).toFixed(2) + '%'
        : '0%',
    });
  }
} 