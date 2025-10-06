import * as amqp from 'amqplib';
import { Connection, Channel, ConfirmChannel, Message } from 'amqplib';
import { logger } from '../../utils/logger';
import { 
  IQueueService, 
  QueueMessage as IQueueMessage, 
  TokenEnrichmentMessage as ITokenEnrichmentMessage, 
  ContractEnrichmentMessage as IContractEnrichmentMessage,
  InternalTransactionMessage as IInternalTransactionMessage,
  DailyStatsMessage as IDailyStatsMessage,
  PublishOptions,
  ConsumeOptions,
  MessageHandler,
  QueueStats,
  ColdStorageMessage,
} from '../../interfaces/services/IQueueService';

// Legacy interfaces for backward compatibility
export interface QueueMessage {
  type: 'TOKEN_ENRICHMENT' | 'CONTRACT_ENRICHMENT' | 'INTERNAL_TRANSACTION' | 'TRANSACTION_ENRICHMENT' | 'DAILY_STATS';
  data: any;
  priority?: number;
  retryCount?: number;
}

export interface TokenEnrichmentMessage {
  tokenAddress: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface InternalTransactionMessage {
  transactionHash: string;
  blockNumber: number;
  fromAddress: string;
  toAddress: string;
}

export interface TransactionEnrichmentMessage {
  transactionHash: string;
  blockNumber: number;
  blockBaseFeePerGas: string;
  transactionType: number;
  gasPrice: string;
  gasUsed: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  input: string | null;
  status: number;
  isContractCreation: boolean;
  fromAddress: string;
  nonce: string;
}

interface QueueConfig {
  exchange: string;
  queues: {
    tokenEnrichment: string;
    contractEnrichment: string;
    //internalTransactions: string;
    transactionEnrichment: string;
    dailyStats: string;
    deadLetter: string;
    coldStorage: string;
  };
  maxRetries: number;
  retryDelay: number;
}

export class RabbitMQService implements IQueueService {
  private connection: Connection | null = null;
  private channel: ConfirmChannel | null = null;
  private isConnectedFlag = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private errorCount = 0;
  private lastError?: string;
  private publisherConfirmsEnabled = false;
  private outstandingConfirms = 0;

  private config: QueueConfig = {
    exchange: 'monad-explorer',
    queues: {
      tokenEnrichment: 'token-enrichment',
      contractEnrichment: 'contract-enrichment',
      //internalTransactions: 'internal-transactions',
      transactionEnrichment: 'transaction-enrichment',
      dailyStats: 'daily-stats',
      deadLetter: 'dead-letter',
      coldStorage: 'cold-storage-ingest',
    },
    maxRetries: 3,
    retryDelay: 30000, // 30 seconds
  };

  constructor(private connectionUrl: string = process.env.RABBITMQ_URL || 'amqp://localhost') {}

  async connect(): Promise<void> {
    try {
      logger.info('Connecting to RabbitMQ...', { url: this.connectionUrl.replace(/\/\/.*@/, '//***:***@') });
      
      this.connection = await amqp.connect(this.connectionUrl);
      this.channel = await this.connection.createConfirmChannel();
      
      // Set up connection event handlers
      this.connection.on('error', this.handleConnectionError.bind(this));
      this.connection.on('close', this.handleConnectionClose.bind(this));
      
      // Publisher confirmations are automatically enabled with createConfirmChannel()
      this.publisherConfirmsEnabled = true;
      logger.info('Publisher confirmations enabled via createConfirmChannel()');
      
      // Set up channel with prefetch for load balancing
      await this.channel.prefetch(10);
      
      // ConfirmChannel uses callbacks instead of events for publish confirmations
      // Individual message confirmations are handled in the publish method callbacks
      
      // Initialize exchanges and queues
      await this.setupInfrastructure();
      
      this.isConnectedFlag = true;
      this.reconnectAttempts = 0;
      
      logger.info('Successfully connected to RabbitMQ with publisher confirmations');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.errorCount++;
      logger.error('Failed to connect to RabbitMQ', { error: this.lastError });
      await this.handleReconnection();
    }
  }

  async disconnect(): Promise<void> {
    await this.close();
  }

  isConnected(): boolean {
    return this.isConnectedFlag;
  }

  private async setupInfrastructure(): Promise<void> {
    if (!this.channel) throw new Error('Channel not available');

    // Declare exchange
    await this.channel.assertExchange(this.config.exchange, 'topic', { durable: true });

    // Declare dead letter exchange and queue
    await this.channel.assertExchange(`${this.config.exchange}-dlx`, 'direct', { durable: true });
    await this.channel.assertQueue(this.config.queues.deadLetter, {
      durable: true,
      arguments: {
        'x-message-ttl': 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    });
    await this.channel.bindQueue(this.config.queues.deadLetter, `${this.config.exchange}-dlx`, '');

    // Declare work queues with dead letter setup
    const queueOptions = {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': `${this.config.exchange}-dlx`,
        'x-dead-letter-routing-key': '',
      },
    };

    await this.channel.assertQueue(this.config.queues.tokenEnrichment, queueOptions);
    await this.channel.assertQueue(this.config.queues.contractEnrichment, queueOptions);
    //await this.channel.assertQueue(this.config.queues.internalTransactions, queueOptions);
    await this.channel.assertQueue(this.config.queues.transactionEnrichment, queueOptions);
    await this.channel.assertQueue(this.config.queues.dailyStats, queueOptions);
    await this.channel.assertQueue(this.config.queues.coldStorage, queueOptions);

    // Bind queues to exchange
    await this.channel.bindQueue(this.config.queues.tokenEnrichment, this.config.exchange, 'token.*');
    await this.channel.bindQueue(this.config.queues.contractEnrichment, this.config.exchange, 'contract.*');
    //await this.channel.bindQueue(this.config.queues.internalTransactions, this.config.exchange, 'transaction.*');
    await this.channel.bindQueue(this.config.queues.transactionEnrichment, this.config.exchange, 'transaction.*');
    await this.channel.bindQueue(this.config.queues.dailyStats, this.config.exchange, 'stats.*');
    const coldRoutingKey = this.toRoutingKey(this.config.queues.coldStorage);
    await this.channel.bindQueue(this.config.queues.coldStorage, this.config.exchange, coldRoutingKey);

    logger.info('RabbitMQ infrastructure setup completed');
  }

  async publishTokenEnrichment(message: ITokenEnrichmentMessage, options?: PublishOptions): Promise<void> {
    const queueMessage: IQueueMessage = {
      type: 'TOKEN_ENRICHMENT',
      data: message,
      priority: options?.priority || 5,
      retryCount: 0,
      timestamp: Date.now(),
      messageId: `TOKEN_ENRICHMENT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    await this.publish('token-enrichment', queueMessage, options);
  }

  async publishContractEnrichment(message: IContractEnrichmentMessage, options?: PublishOptions): Promise<void> {
    const queueMessage: IQueueMessage = {
      type: 'CONTRACT_ENRICHMENT',
      data: message,
      priority: options?.priority || 3,
      retryCount: 0,
      timestamp: Date.now(),
      messageId: `CONTRACT_ENRICHMENT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    await this.publish('contract-enrichment', queueMessage, options);
  }

  /* async publishInternalTransaction(message: IInternalTransactionMessage, options?: PublishOptions): Promise<void> {
    const queueMessage: IQueueMessage = {
      type: 'INTERNAL_TRANSACTION',
      data: message,
      priority: options?.priority || 3,
      retryCount: 0,
      timestamp: Date.now(),
      messageId: `INTERNAL_TRANSACTION-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    await this.publish('internal-transactions', queueMessage, options);
  }
 */
  async publishDailyStats(message: IDailyStatsMessage, options?: PublishOptions): Promise<void> {
    const queueMessage: IQueueMessage = {
      type: 'DAILY_STATS',
      data: message,
      priority: options?.priority || 6,
      retryCount: 0,
      timestamp: Date.now(),
      messageId: `DAILY_STATS-${message.date}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    await this.publish('daily-stats', queueMessage, options);
  }

  async publishTransactionEnrichment(message: TransactionEnrichmentMessage, options?: PublishOptions): Promise<void> {
    const queueMessage: IQueueMessage = {
      type: 'TRANSACTION_ENRICHMENT',
      data: message,
      priority: options?.priority || 8,
      retryCount: 0,
      timestamp: Date.now(),
      messageId: `TRANSACTION_ENRICHMENT-${message.transactionHash}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    await this.publish('transaction-enrichment', queueMessage, options);
  }

  async publishTransactionEnrichmentBatch(batchMessage: any, options?: PublishOptions): Promise<void> {
    const queueMessage: IQueueMessage = {
      type: 'TRANSACTION_ENRICHMENT_BATCH',
      data: batchMessage,
      priority: options?.priority || 8,
      retryCount: 0,
      timestamp: Date.now(),
      messageId: `TRANSACTION_ENRICHMENT_BATCH-${batchMessage.blockNumber}-${batchMessage.batchId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    };

    await this.publish('transaction-enrichment', queueMessage, options);
  }

  // Legacy method for backward compatibility
  async publishMessage(routingKey: string, message: any, options?: PublishOptions): Promise<void> {
    if (routingKey === 'transaction.enrichment') {
      await this.publishTransactionEnrichment(message, options);
    } else {
      // Generic publish for other message types
      const queueMessage: IQueueMessage = {
        type: 'GENERIC',
        data: message,
        priority: options?.priority || 5,
        retryCount: 0,
        timestamp: Date.now(),
        messageId: `GENERIC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      };

      await this.publish(routingKey.replace('.', '-'), queueMessage, options);
    }
  }

  async publish<T>(queueName: string, message: IQueueMessage<T>, options?: PublishOptions): Promise<void> {
    if (!this.isConnectedFlag || !this.channel) {
      this.lastError = 'RabbitMQ not connected';
      this.errorCount++;
      logger.error('Cannot publish message: RabbitMQ not connected');
      throw new Error('RabbitMQ not connected');
    }

    try {
      const buffer = Buffer.from(JSON.stringify(message));
      const routingKey = this.toRoutingKey(queueName);
      
      // Retry logic for backpressure handling with ConfirmChannel callbacks
      let retryCount = 0;
      const maxRetries = 3;
      const baseDelay = 100; // Start with 100ms delay
      
      const attemptPublish = async (attempt: number): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
          const published = this.channel!.publish(
            this.config.exchange,
            routingKey,
            buffer,
            {
              persistent: options?.persistent ?? true,
              priority: options?.priority || 5,
              timestamp: Date.now(),
              messageId: message.messageId,
              expiration: options?.expiration,
            },
            (err) => {
              if (err) {
                // Message was nacked by broker
                logger.warn('Message nacked by broker', { 
                  queueName, 
                  type: message.type,
                  messageId: message.messageId,
                  error: err.message
                });
                reject(err);
                } else {
                 // Message was acked by broker
                 this.outstandingConfirms = Math.max(0, this.outstandingConfirms - 1);
                 // Removed excessive debug logging for performance optimization
                 resolve();
               }
            }
          );

          if (!published) {
            // Channel buffer is full, implement backpressure
            if (attempt < maxRetries) {
              const delay = baseDelay * Math.pow(2, attempt);
              logger.debug('Channel buffer full, retrying after delay', { 
                queueName, 
                retryCount: attempt + 1, 
                delay,
                messageType: message.type 
              });
              setTimeout(() => {
                attemptPublish(attempt + 1).then(resolve).catch(reject);
              }, delay);
            } else {
              // Final attempt failed - log warning but resolve for eventual consistency
              logger.warn('Message buffer full after retries, message queued for eventual delivery', { 
                queueName, 
                type: message.type,
                messageId: message.messageId,
                retryCount: attempt + 1
              });
              resolve(); // Don't reject - message will be delivered eventually
            }
            } else {
             // Message was accepted into buffer - track as outstanding
             this.outstandingConfirms++;
           }
        });
      };

      await attemptPublish(retryCount);

      // Removed excessive debug logging for performance optimization
      // Only log important events like errors or periodic summaries
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.errorCount++;
      logger.error('Failed to publish message', { 
        error: this.lastError, 
        queueName, 
        messageType: message.type 
      });
      throw error;
    }
  }

  private toRoutingKey(queueName: string): string {
    return queueName.includes('-') ? queueName.replace(/-/g, '.') : queueName;
  }



  async consumeTokenEnrichment(handler: MessageHandler<ITokenEnrichmentMessage>, options?: ConsumeOptions): Promise<void> {
    await this.consume(this.config.queues.tokenEnrichment, async (message: IQueueMessage) => {
      if (message.type !== 'TOKEN_ENRICHMENT') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as ITokenEnrichmentMessage);
    }, options);
  }

  async consumeContractEnrichment(handler: MessageHandler<IContractEnrichmentMessage>, options?: ConsumeOptions): Promise<void> {
    await this.consume(this.config.queues.contractEnrichment, async (message: IQueueMessage) => {
      if (message.type !== 'CONTRACT_ENRICHMENT') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as IContractEnrichmentMessage);
    }, options);
  }

  async consumeColdStorage(handler: MessageHandler<ColdStorageMessage>, options?: ConsumeOptions): Promise<void> {
    await this.consume(this.config.queues.coldStorage, async (message: IQueueMessage) => {
      if (message.type !== 'COLD_STORAGE_BATCH') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as ColdStorageMessage);
    }, options);
  }

  /* async consumeInternalTransactions(handler: MessageHandler<IInternalTransactionMessage>, options?: ConsumeOptions): Promise<void> {
      await this.consume(this.config.queues.internalTransactions, async (message: IQueueMessage) => {
      if (message.type !== 'INTERNAL_TRANSACTION') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as IInternalTransactionMessage);
    }, options);
  } */

  async consumeDailyStats(handler: MessageHandler<IDailyStatsMessage>, options?: ConsumeOptions): Promise<void> {
    await this.consume(this.config.queues.dailyStats, async (message: IQueueMessage) => {
      if (message.type !== 'DAILY_STATS') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as IDailyStatsMessage);
    }, options);
  }

  async consumeTransactionEnrichment(handler: MessageHandler<TransactionEnrichmentMessage>, options?: ConsumeOptions): Promise<void> {
    await this.consume(this.config.queues.transactionEnrichment, async (message: IQueueMessage) => {
      if (message.type !== 'TRANSACTION_ENRICHMENT' && message.type !== 'TRANSACTION_ENRICHMENT_BATCH') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      // Pass the entire message object for batch handling
      await handler(message as any);
    }, options);
  }

  async consume<T>(queueName: string, handler: MessageHandler<T>, options?: ConsumeOptions): Promise<void> {
    if (!this.isConnectedFlag || !this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    if (options?.prefetch) {
      await this.channel.prefetch(options.prefetch);
    }

    await this.channel.consume(queueName, async (msg: Message | null) => {
      if (!msg) return;

      try {
        const content = JSON.parse(msg.content.toString()) as T;
        
        /* logger.debug('Processing message', { 
          queue: queueName, 
          messageId: msg.properties.messageId
        }); */

        await handler(content);
        
        // Acknowledge successful processing
        if (!options?.autoAck) {
          this.channel?.ack(msg);
        }
        
        /* logger.debug('Message processed successfully', { 
          queue: queueName, 
          messageId: msg.properties.messageId
        }); */
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.errorCount++;
        logger.error('Failed to process message', { 
          queue: queueName, 
          error: this.lastError 
        });

        // Handle retry logic
        await this.handleMessageError(msg, error instanceof Error ? error : new Error(String(error)));
      }
    }, { noAck: options?.autoAck ?? false });

    logger.info(`Started consuming from queue: ${queueName}`);
  }

  async getQueueStats(queueName: string): Promise<QueueStats> {
    if (!this.isConnectedFlag || !this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    try {
      const queueInfo = await this.channel.checkQueue(queueName);
      return {
        messageCount: queueInfo.messageCount,
        consumerCount: queueInfo.consumerCount,
        publishedTotal: 0, // RabbitMQ doesn't provide this directly
        processedTotal: 0, // RabbitMQ doesn't provide this directly
        failedTotal: this.errorCount,
        retryTotal: 0, // RabbitMQ doesn't provide this directly
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.errorCount++;
      throw error;
    }
  }

  async getAllQueueStats(): Promise<Record<string, QueueStats>> {
    const stats: Record<string, QueueStats> = {};
    
    for (const [name, queueName] of Object.entries(this.config.queues)) {
      try {
        stats[name] = await this.getQueueStats(queueName);
      } catch (error) {
        logger.warn(`Failed to get stats for queue ${queueName}`, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return stats;
  }

  async purgeQueue(queueName: string): Promise<number> {
    if (!this.isConnectedFlag || !this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    try {
      const result = await this.channel.purgeQueue(queueName);
      logger.info(`Purged ${result.messageCount} messages from queue ${queueName}`);
      return result.messageCount;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.errorCount++;
      logger.error(`Failed to purge queue ${queueName}`, { error: this.lastError });
      throw error;
    }
  }

  async getHealthStatus(): Promise<{
    connected: boolean;
    queuesHealthy: boolean;
    publisherConfirms: boolean;
    outstandingConfirms: number;
    errorCount: number;
    lastError?: string;
  }> {
    let queuesHealthy = false;
    
    if (this.isConnectedFlag) {
      try {
        // Check if we can access queue info
        await this.getAllQueueStats();
        queuesHealthy = true;
      } catch (error) {
        queuesHealthy = false;
      }
    }

    return {
      connected: this.isConnectedFlag,
      queuesHealthy,
      publisherConfirms: this.publisherConfirmsEnabled,
      outstandingConfirms: this.outstandingConfirms,
      errorCount: this.errorCount,
      lastError: this.lastError,
    };
  }

  private async handleMessageError(msg: Message, error: Error): Promise<void> {
    if (!this.channel) return;

    try {
      const content = JSON.parse(msg.content.toString()) as IQueueMessage;
      const retryCount = (content.retryCount || 0) + 1;

      if (retryCount <= this.config.maxRetries) {
        // Retry with delay
        const updatedMessage: IQueueMessage = {
          ...content,
          retryCount,
        };

        const buffer = Buffer.from(JSON.stringify(updatedMessage));
        
        // Publish to retry queue with delay
        setTimeout(async () => {
          if (this.channel) {
            let routingKey: string;
            switch (content.type) {
              case 'TOKEN_ENRICHMENT':
                routingKey = 'token.enrichment';
                break;
              case 'CONTRACT_ENRICHMENT':
                routingKey = 'contract.enrichment';
                break;
              case 'INTERNAL_TRANSACTION':
                routingKey = 'transaction.internal';
                break;
              case 'TRANSACTION_ENRICHMENT':
                routingKey = 'transaction.enrichment';
                break;
              case 'DAILY_STATS':
                routingKey = 'stats.daily';
                break;
              default:
                routingKey = 'unknown';
            }
            
            const published = this.channel.publish(
              this.config.exchange,
              routingKey,
              buffer,
              {
                persistent: true,
                priority: 1, // Lower priority for retries
                timestamp: Date.now(),
                messageId: content.messageId,
              }
            );
            
            if (!published) {
              logger.error('Failed to publish retry message');
            }
          }
        }, this.config.retryDelay);

        this.channel.ack(msg);
        
        logger.warn('Message scheduled for retry', { 
          type: content.type, 
          retryCount, 
          error: error.message 
        });
      } else {
        // Max retries exceeded, send to dead letter queue
        this.channel.nack(msg, false, false);
        
        logger.error('Message exceeded max retries, sent to dead letter queue', { 
          type: content.type, 
          retryCount, 
          error: error.message 
        });
      }
    } catch (parseError) {
      // If we can't parse the message, just nack it
      this.channel.nack(msg, false, false);
      const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
      logger.error('Failed to parse message for retry handling', { error: errorMessage });
    }
  }

  private handleConnectionError(error: Error): void {
    logger.error('RabbitMQ connection error', { error: error.message });
    this.isConnectedFlag = false;
    this.lastError = error.message;
    this.errorCount++;
  }

  private handleConnectionClose(): void {
    logger.warn('RabbitMQ connection closed');
    this.isConnectedFlag = false;
    this.handleReconnection();
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached, giving up');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

    logger.info(`Attempting to reconnect to RabbitMQ (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms`);

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Reconnection attempt failed', { error: errorMessage });
      }
    }, delay);
  }

  async getQueueInfo(): Promise<Record<string, any>> {
    return this.getAllQueueStats();
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.isConnectedFlag = false;
      this.publisherConfirmsEnabled = false;
      this.outstandingConfirms = 0;
      logger.info('RabbitMQ connection closed');
    }
  }

  get connected(): boolean {
    return this.isConnectedFlag;
  }

  /**
   * Get publisher confirmation status
   */
  getPublisherConfirmStatus(): { enabled: boolean; outstandingConfirms: number } {
    return {
      enabled: this.publisherConfirmsEnabled,
      outstandingConfirms: this.outstandingConfirms
    };
  }
}

// Singleton instance
export const rabbitMQService = new RabbitMQService(); 
