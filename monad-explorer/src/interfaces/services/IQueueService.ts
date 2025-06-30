export interface QueueMessage<T = unknown> {
  type: string;
  data: T;
  priority?: number;
  retryCount?: number;
  timestamp?: number;
  messageId?: string;
}

export interface TokenEnrichmentMessage {
  tokenAddress: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  detectedType?: string;
}

export interface ContractEnrichmentMessage {
  contractAddress: string;
  creator: string;
  blockNumber: number;
  transactionHash: string;
  deploymentBytecode?: string;
}

export interface InternalTransactionMessage {
  transactionHash: string;
  blockNumber: number;
  fromAddress: string;
  toAddress: string;
  value?: string;
}

export interface QueueStats {
  messageCount: number;
  consumerCount: number;
  publishedTotal: number;
  processedTotal: number;
  failedTotal: number;
  retryTotal: number;
}

export interface PublishOptions {
  priority?: number;
  delay?: number;
  persistent?: boolean;
  expiration?: number;
}

export interface ConsumeOptions {
  concurrency?: number;
  prefetch?: number;
  autoAck?: boolean;
}

export type MessageHandler<T = unknown> = (message: T) => Promise<void>;

export interface IQueueService {
  /**
   * Connect to message queue
   */
  connect(): Promise<void>;

  /**
   * Disconnect from message queue
   */
  disconnect(): Promise<void>;

  /**
   * Check if connected
   */
  isConnected(): boolean;

  /**
   * Publish token enrichment message
   */
  publishTokenEnrichment(
    message: TokenEnrichmentMessage,
    options?: PublishOptions
  ): Promise<void>;

  /**
   * Publish contract enrichment message
   */
  publishContractEnrichment(
    message: ContractEnrichmentMessage,
    options?: PublishOptions
  ): Promise<void>;

  /**
   * Publish internal transaction message
   */
  publishInternalTransaction(
    message: InternalTransactionMessage,
    options?: PublishOptions
  ): Promise<void>;

  /**
   * Publish generic message
   */
  publish<T>(
    queueName: string,
    message: QueueMessage<T>,
    options?: PublishOptions
  ): Promise<void>;

  /**
   * Consume token enrichment messages
   */
  consumeTokenEnrichment(
    handler: MessageHandler<TokenEnrichmentMessage>,
    options?: ConsumeOptions
  ): Promise<void>;

  /**
   * Consume contract enrichment messages
   */
  consumeContractEnrichment(
    handler: MessageHandler<ContractEnrichmentMessage>,
    options?: ConsumeOptions
  ): Promise<void>;

  /**
   * Consume internal transaction messages
   */
  consumeInternalTransactions(
    handler: MessageHandler<InternalTransactionMessage>,
    options?: ConsumeOptions
  ): Promise<void>;

  /**
   * Consume from specific queue
   */
  consume<T>(
    queueName: string,
    handler: MessageHandler<T>,
    options?: ConsumeOptions
  ): Promise<void>;

  /**
   * Get queue statistics
   */
  getQueueStats(queueName: string): Promise<QueueStats>;

  /**
   * Get all queues statistics
   */
  getAllQueueStats(): Promise<Record<string, QueueStats>>;

  /**
   * Purge queue (remove all messages)
   */
  purgeQueue(queueName: string): Promise<number>;

  /**
   * Get health status
   */
  getHealthStatus(): Promise<{
    connected: boolean;
    queuesHealthy: boolean;
    errorCount: number;
    lastError?: string;
  }>;
} 