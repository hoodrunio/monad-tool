import * as amqp from 'amqplib';
import { Connection, Channel, Message } from 'amqplib';
import { logger } from '../../utils/logger';

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

export class RabbitMQService {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;

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
      
      this.isConnected = true;
      this.reconnectAttempts = 0;
      
      logger.info('Successfully connected to RabbitMQ');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to connect to RabbitMQ', { error: errorMessage });
      await this.handleReconnection();
    }
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

  async publishTokenEnrichment(message: TokenEnrichmentMessage, priority = 5): Promise<void> {
    const queueMessage: QueueMessage = {
      type: 'TOKEN_ENRICHMENT',
      data: message,
      priority,
      retryCount: 0,
    };

    await this.publish('token.enrichment', queueMessage, priority);
  }

  async publishInternalTransaction(message: InternalTransactionMessage, priority = 3): Promise<void> {
    const queueMessage: QueueMessage = {
      type: 'INTERNAL_TRANSACTION',
      data: message,
      priority,
      retryCount: 0,
    };

    await this.publish('transaction.internal', queueMessage, priority);
  }

  private async publish(routingKey: string, message: QueueMessage, priority = 5): Promise<void> {
    if (!this.isConnected || !this.channel) {
      logger.error('Cannot publish message: RabbitMQ not connected');
      throw new Error('RabbitMQ not connected');
    }

    try {
      const buffer = Buffer.from(JSON.stringify(message));
      const published = this.channel.publish(
        this.config.exchange,
        routingKey,
        buffer,
        {
          persistent: true,
          priority,
          timestamp: Date.now(),
          messageId: `${message.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        }
      );

      if (!published) {
        throw new Error('Failed to publish message to exchange');
      }

      logger.debug('Message published successfully', { routingKey, type: message.type });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to publish message', { 
        error: errorMessage, 
        routingKey, 
        messageType: message.type 
      });
      throw error;
    }
  }

  async consumeTokenEnrichment(handler: (message: TokenEnrichmentMessage) => Promise<void>): Promise<void> {
    await this.consume(this.config.queues.tokenEnrichment, async (message: QueueMessage) => {
      if (message.type !== 'TOKEN_ENRICHMENT') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as TokenEnrichmentMessage);
    });
  }

  async consumeInternalTransactions(handler: (message: InternalTransactionMessage) => Promise<void>): Promise<void> {
    await this.consume(this.config.queues.internalTransactions, async (message: QueueMessage) => {
      if (message.type !== 'INTERNAL_TRANSACTION') {
        throw new Error(`Invalid message type: ${message.type}`);
      }
      await handler(message.data as InternalTransactionMessage);
    });
  }

  private async consume(queueName: string, handler: (message: QueueMessage) => Promise<void>): Promise<void> {
    if (!this.isConnected || !this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    await this.channel.consume(queueName, async (msg: Message | null) => {
      if (!msg) return;

      try {
        const content = JSON.parse(msg.content.toString()) as QueueMessage;
        
        logger.debug('Processing message', { 
          queue: queueName, 
          type: content.type, 
          retryCount: content.retryCount 
        });

        await handler(content);
        
        // Acknowledge successful processing
        this.channel?.ack(msg);
        
        logger.debug('Message processed successfully', { 
          queue: queueName, 
          type: content.type 
        });
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Failed to process message', { 
          queue: queueName, 
          error: errorMessage 
        });

        // Handle retry logic
        await this.handleMessageError(msg, error instanceof Error ? error : new Error(String(error)));
      }
    });

    logger.info(`Started consuming from queue: ${queueName}`);
  }

  private async handleMessageError(msg: Message, error: Error): Promise<void> {
    if (!this.channel) return;

    try {
      const content = JSON.parse(msg.content.toString()) as QueueMessage;
      const retryCount = (content.retryCount || 0) + 1;

      if (retryCount <= this.config.maxRetries) {
        // Retry with delay
        const updatedMessage: QueueMessage = {
          ...content,
          retryCount,
        };

        const buffer = Buffer.from(JSON.stringify(updatedMessage));
        
        // Publish to retry queue with delay
        setTimeout(async () => {
          if (this.channel) {
            const routingKey = content.type === 'TOKEN_ENRICHMENT' ? 'token.enrichment' : 'transaction.internal';
            await this.publish(routingKey, updatedMessage, 1); // Lower priority for retries
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
    this.isConnected = false;
  }

  private handleConnectionClose(): void {
    logger.warn('RabbitMQ connection closed');
    this.isConnected = false;
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
    if (!this.isConnected || !this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    const info: Record<string, any> = {};
    
    for (const [name, queueName] of Object.entries(this.config.queues)) {
      try {
        const queueInfo = await this.channel.checkQueue(queueName);
        info[name] = {
          messageCount: queueInfo.messageCount,
          consumerCount: queueInfo.consumerCount,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        info[name] = { error: errorMessage };
      }
    }

    return info;
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.isConnected = false;
      logger.info('RabbitMQ connection closed');
    }
  }

  get connected(): boolean {
    return this.isConnected;
  }
}

// Singleton instance
export const rabbitMQService = new RabbitMQService(); 