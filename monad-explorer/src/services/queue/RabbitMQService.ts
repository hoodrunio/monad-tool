import * as amqp from 'amqplib';
import { Connection, Channel, Message } from 'amqplib';
import { logger } from '../../utils/logger';
import { 
  IQueueService, 
  QueueMessage as IQueueMessage, 
  TokenEnrichmentMessage as ITokenEnrichmentMessage, 
  InternalTransactionMessage as IInternalTransactionMessage,
  PublishOptions,
  ConsumeOptions,
  MessageHandler,
  QueueStats
} from '../../interfaces/services/IQueueService';

// Legacy interfaces for backward compatibility
export interface QueueMessage {
  type: 'TOKEN_ENRICHMENT' | 'INTERNAL_TRANSACTION';
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

interface QueueConfig {
  exchange: string;
  queues: {
    tokenEnrichment: string;
    internalTransactions: string;
    deadLetter: string;
  };
  maxRetries: number;
  retryDelay: number;
}

export class RabbitMQService implements IQueueService {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private isConnectedFlag = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private errorCount = 0;
  private lastError?: string;

  private config: QueueConfig = {
    exchange: 'monad-explorer',
    queues: {
      tokenEnrichment: 'token-enrichment',
      internalTransactions: 'internal-transactions',
      deadLetter: 'dead-letter',
    },
    maxRetries: 3,
    retryDelay: 30000, // 30 seconds
  };

  constructor(private connectionUrl: string = process.env.RABBITMQ_URL || 'amqp://localhost') {}

  async connect(): Promise<void> {
    try {
      logger.info('Connecting to RabbitMQ...', { url: this.connectionUrl.replace(/\/\/.*@/, '//***:***@') });
      
      this.connection = await amqp.connect(this.connectionUrl);
      this.channel = await this.connection.createChannel();
      
      // Set up connection event handlers
      this.connection.on('error', this.handleConnectionError.bind(this));
      this.connection.on('close', this.handleConnectionClose.bind(this));
      
      // Set up channel with prefetch for load balancing
      await this.channel.prefetch(10);
      
      // Initialize exchanges and queues
      await this.setupInfrastructure();
      
      this.isConnectedFlag = true;
      this.reconnectAttempts = 0;
      
      logger.info('Successfully connected to RabbitMQ');
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
    await this.channel.assertQueue(this.config.queues.internalTransactions, queueOptions);

    // Bind queues to exchange
    await this.channel.bindQueue(this.config.queues.tokenEnrichment, this.config.exchange, 'token.*');
    await this.channel.bindQueue(this.config.queues.internalTransactions, this.config.exchange, 'transaction.*');

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

  async publishInternalTransaction(message: IInternalTransactionMessage, options?: PublishOptions): Promise<void> {
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

  async publish<T>(queueName: string, message: IQueueMessage<T>, options?: PublishOptions): Promise<void> {
    if (!this.isConnectedFlag || !this.channel) {
      this.lastError = 'RabbitMQ not connected';
      this.errorCount++;
      logger.error('Cannot publish message: RabbitMQ not connected');
      throw new Error('RabbitMQ not connected');
    }

    try {
      const buffer = Buffer.from(JSON.stringify(message));
      const routingKey = queueName.includes('-') ? queueName.replace('-', '.') : queueName;
      
      const published = this.channel.publish(
        this.config.exchange,
        routingKey,
        buffer,
        {
          persistent: options?.persistent ?? true,
          priority: options?.priority || 5,
          timestamp: Date.now(),
          messageId: message.messageId,
          expiration: options?.expiration,
        }
      );

      if (!published) {
        throw new Error('Failed to publish message to exchange');
      }

      logger.debug('Message published successfully', { queueName, type: message.type });
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

  async consumeTokenEnrichment(handler: MessageHandler<ITokenEnrichmentMessage>, options?: ConsumeOptions): Promise<void> {
    await this.consume(this.config.queues.tokenEnrichment, async (message: IQueueMessage) => {
      if (message.type !== 'TOKEN_ENRICHMENT') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as ITokenEnrichmentMessage);
    }, options);
  }

  async consumeInternalTransactions(handler: MessageHandler<IInternalTransactionMessage>, options?: ConsumeOptions): Promise<void> {
    await this.consume(this.config.queues.internalTransactions, async (message: IQueueMessage) => {
      if (message.type !== 'INTERNAL_TRANSACTION') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as IInternalTransactionMessage);
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
        
        logger.debug('Processing message', { 
          queue: queueName, 
          messageId: msg.properties.messageId
        });

        await handler(content);
        
        // Acknowledge successful processing
        if (!options?.autoAck) {
          this.channel?.ack(msg);
        }
        
        logger.debug('Message processed successfully', { 
          queue: queueName, 
          messageId: msg.properties.messageId
        });
        
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
            const routingKey = content.type === 'TOKEN_ENRICHMENT' ? 'token.enrichment' : 'transaction.internal';
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
      logger.info('RabbitMQ connection closed');
    }
  }

  get connected(): boolean {
    return this.isConnectedFlag;
  }
}

// Singleton instance
export const rabbitMQService = new RabbitMQService(); 