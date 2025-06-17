// Monad Validator Analytics - Data Ingestion Service
// Orchestrates log processing, database storage, and caching for real-time analytics

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { LogProcessor } from '../log-processor/processor';
import { MonadClickHouseClient, ClickHouseConfig } from '../database/clickhouse-client';
import { MonadRedisClient, RedisConfig } from '../cache/redis-client';
import { 
  RawLog, 
  ProcessingConfig, 
  LogProcessingResult,
  ProcessingMetrics
} from '../log-processor/types';

export interface IngestionConfig {
  clickhouse: ClickHouseConfig;
  redis: RedisConfig;
  processing: ProcessingConfig;
  ingestion: {
    batchSize: number;
    batchTimeoutMs: number;
    maxConcurrentBatches: number;
    errorRetryAttempts: number;
    enableRealTimeUpdates: boolean;
    enablePerformanceMonitoring: boolean;
  };
}

export interface IngestionMetrics {
  totalLogsProcessed: number;
  successfulBatches: number;
  failedBatches: number;
  avgProcessingTimeMs: number;
  avgBatchSize: number;
  logsPerSecond: number;
  errorRate: number;
  lastProcessedTimestamp: Date;
}

export class DataIngestionService extends EventEmitter {
  private logProcessor: LogProcessor;
  private clickhouseClient: MonadClickHouseClient;
  private redisClient: MonadRedisClient;
  private config: IngestionConfig;
  private isRunning: boolean = false;
  private metrics: IngestionMetrics;
  private processingQueue: RawLog[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private serviceStartTime: number = 0;

  constructor(config: IngestionConfig) {
    super();
    this.config = config;
    this.logProcessor = new LogProcessor();
    this.clickhouseClient = new MonadClickHouseClient(config.clickhouse);
    this.redisClient = new MonadRedisClient(config.redis);
    
    this.metrics = {
      totalLogsProcessed: 0,
      successfulBatches: 0,
      failedBatches: 0,
      avgProcessingTimeMs: 0,
      avgBatchSize: 0,
      logsPerSecond: 0,
      errorRate: 0,
      lastProcessedTimestamp: new Date()
    };

    this.setupErrorHandling();
  }

  // =============================================
  // SERVICE LIFECYCLE MANAGEMENT
  // =============================================

  async start(): Promise<void> {
    console.log('Starting Monad Data Ingestion Service...');
    
    try {
      // Record service start time
      this.serviceStartTime = Date.now();
      
      // Initialize database schema
      await this.clickhouseClient.initializeSchema();
      
      // Test database connectivity
      const dbConnected = await this.clickhouseClient.ping();
      if (!dbConnected) {
        throw new Error('Failed to connect to ClickHouse');
      }
      
      // Test cache connectivity
      const cacheConnected = await this.redisClient.ping();
      if (!cacheConnected) {
        throw new Error('Failed to connect to Redis');
      }
      
      // Warm up cache
      await this.redisClient.warmupCache();
      
      this.isRunning = true;
      this.startBatchProcessor();
      
      // Setup real-time update publishing if enabled
      if (this.config.ingestion.enableRealTimeUpdates) {
        this.setupRealTimeUpdates();
      }
      
      // Setup performance monitoring if enabled
      if (this.config.ingestion.enablePerformanceMonitoring) {
        this.startPerformanceMonitoring();
      }
      
      console.log('Data Ingestion Service started successfully');
      this.emit('started');
    } catch (error) {
      console.error('Failed to start Data Ingestion Service:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.log('Stopping Data Ingestion Service...');
    
    this.isRunning = false;
    
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    
    // Process remaining logs in queue
    if (this.processingQueue.length > 0) {
      await this.processBatch(this.processingQueue);
      this.processingQueue = [];
    }
    
    // Close connections
    await this.clickhouseClient.close();
    await this.redisClient.close();
    
    console.log('Data Ingestion Service stopped');
    this.emit('stopped');
  }

  // =============================================
  // LOG INGESTION METHODS
  // =============================================

  async ingestLog(logLine: string): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service is not running');
    }

    try {
      const parsedLog = JSON.parse(logLine);
      const rawLog: RawLog = {
        timestamp: parsedLog.timestamp,
        level: parsedLog.level || 'INFO',
        fields: parsedLog.fields || {},
        target: parsedLog.target || 'unknown'
      };

      this.processingQueue.push(rawLog);
      
      // Process batch if queue size reached
      if (this.processingQueue.length >= this.config.ingestion.batchSize) {
        await this.processBatch(this.processingQueue.splice(0, this.config.ingestion.batchSize));
      }
    } catch (error) {
      console.error('Failed to ingest log:', error);
      this.emit('ingestionError', { error, logLine });
    }
  }

  async ingestBatch(logLines: string[]): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Service is not running');
    }

    const rawLogs: RawLog[] = [];
    
    for (const logLine of logLines) {
      try {
        const parsedLog = JSON.parse(logLine);
        rawLogs.push({
          timestamp: parsedLog.timestamp,
          level: parsedLog.level || 'INFO',
          fields: parsedLog.fields || {},
          target: parsedLog.target || 'unknown'
        });
      } catch (error) {
        console.error('Failed to parse log in batch:', error);
      }
    }

    if (rawLogs.length > 0) {
      await this.processBatch(rawLogs);
    }
  }

  // =============================================
  // BATCH PROCESSING
  // =============================================

  private async processBatch(logs: RawLog[]): Promise<void> {
    const startTime = Date.now();
    
    try {
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      console.log(`Processing batch ${batchId} with ${logs.length} logs`);
      
      // Process logs through the enhanced processor
      const consensusEvents = [];
      const ledgerEvents = [];
      
      for (const log of logs) {
        const processed = this.logProcessor.parseLog(JSON.stringify(log));
        if (processed) {
          // Convert basic parsed event to proper typed event
          const typedEvent = {
            ...processed,
            timestamp: new Date(processed.timestamp),
            eventType: processed.eventType,
            validatorId: processed.validatorId || 'unknown',
            roundNumber: processed.roundNumber || 0,
            epochNumber: processed.epochNumber || 1,
            blockNumber: processed.blockNumber || null,
            blockId: processed.blockId || null,
            parentVoteId: null,
            parentRound: null,
            nextLeaderId: null,
            blockTimestampMs: null,
            processingTimestampMs: Date.now(),
            processingDelayMs: 0,
            transactionCount: 0,
            stateRootAction: '',
            sequenceNumber: null,
            validatorDns: '',
            geographicRegion: 'unknown',
            infrastructureProvider: 'unknown',
            datacenterCode: 'unknown',
            isSuccessful: true,
            participantCount: null,
            participationRate: null,
            metadata: JSON.stringify(processed.raw || {}),
            ingestionId: uuidv4()
          };
          
          if (log.target === 'monad_consensus_state') {
            consensusEvents.push(typedEvent);
          } else if (log.target === 'ledger_tail') {
            ledgerEvents.push(typedEvent);
          }
        }
      }
      
      // Store in ClickHouse
      if (consensusEvents.length > 0) {
        await this.clickhouseClient.insertValidatorEvents(consensusEvents);
      }
      
      if (ledgerEvents.length > 0) {
        await this.clickhouseClient.insertLedgerEvents(ledgerEvents);
      }
      
      // Update cache invalidation patterns
      await this.invalidateRelevantCache(consensusEvents.concat(ledgerEvents));
      
      // Update metrics
      const processingTime = Date.now() - startTime;
      this.updateMetrics(logs.length, processingTime, true);
      
      // Emit processed event for real-time updates
      this.emit('batchProcessed', {
        batchId,
        logsProcessed: logs.length,
        eventsGenerated: consensusEvents.length + ledgerEvents.length,
        processingTimeMs: processingTime
      });
      
      console.log(`Batch ${batchId} processed successfully in ${processingTime}ms`);
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.updateMetrics(logs.length, processingTime, false);
      
      console.error('Failed to process batch:', error);
      this.emit('batchError', { error, batchSize: logs.length });
      
      // Retry logic if enabled
      if (this.config.ingestion.errorRetryAttempts > 0) {
        await this.retryBatch(logs, 1);
      }
    }
  }

  private async retryBatch(logs: RawLog[], attempt: number): Promise<void> {
    if (attempt > this.config.ingestion.errorRetryAttempts) {
      console.error(`Max retry attempts reached for batch of ${logs.length} logs`);
      return;
    }
    
    console.log(`Retrying batch processing, attempt ${attempt}/${this.config.ingestion.errorRetryAttempts}`);
    
    // Exponential backoff
    const delay = Math.pow(2, attempt) * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      await this.processBatch(logs);
    } catch (error) {
      await this.retryBatch(logs, attempt + 1);
    }
  }

  private startBatchProcessor(): void {
    this.batchTimer = setInterval(async () => {
      if (this.processingQueue.length > 0) {
        const batch = this.processingQueue.splice(0, this.config.ingestion.batchSize);
        await this.processBatch(batch);
      }
    }, this.config.ingestion.batchTimeoutMs);
  }

  // =============================================
  // CACHE MANAGEMENT
  // =============================================

  private async invalidateRelevantCache(events: any[]): Promise<void> {
    if (events.length === 0) return;
    
    try {
      // Invalidate validator rankings cache
      await this.redisClient.invalidatePattern('validator_rankings:*');
      
      // Invalidate network metrics cache
      await this.redisClient.invalidatePattern('network_metrics:*');
      
      // Invalidate geographic distribution cache
      await this.redisClient.invalidatePattern('geographic_distribution');
      
      // Invalidate specific validator histories for affected validators
      const affectedValidators = [...new Set(events.map(e => e.validatorId))];
      for (const validatorId of affectedValidators) {
        await this.redisClient.invalidatePattern(`validator_history:${validatorId}:*`);
      }
      
    } catch (error) {
      console.error('Failed to invalidate cache:', error);
    }
  }

  // =============================================
  // REAL-TIME UPDATES
  // =============================================

  private setupRealTimeUpdates(): void {
    this.on('batchProcessed', async (data) => {
      // Publish real-time updates to subscribed clients
      await this.redisClient.publishUpdate('validator_updates', {
        type: 'batch_processed',
        timestamp: new Date(),
        ...data
      });
    });
    
    this.on('metricsUpdated', async (metrics) => {
      // Publish performance metrics updates
      await this.redisClient.publishUpdate('performance_metrics', {
        type: 'metrics_update',
        timestamp: new Date(),
        metrics
      });
    });
  }

  // =============================================
  // PERFORMANCE MONITORING
  // =============================================

  private startPerformanceMonitoring(): void {
    setInterval(() => {
      this.emit('metricsUpdated', this.getMetrics());
    }, 30000); // Emit metrics every 30 seconds
  }

  private updateMetrics(batchSize: number, processingTime: number, success: boolean): void {
    this.metrics.totalLogsProcessed += batchSize;
    this.metrics.lastProcessedTimestamp = new Date();
    
    if (success) {
      this.metrics.successfulBatches++;
    } else {
      this.metrics.failedBatches++;
    }
    
    // Update averages
    const totalBatches = this.metrics.successfulBatches + this.metrics.failedBatches;
    this.metrics.avgProcessingTimeMs = 
      (this.metrics.avgProcessingTimeMs * (totalBatches - 1) + processingTime) / totalBatches;
    
    this.metrics.avgBatchSize = this.metrics.totalLogsProcessed / totalBatches;
    
    // Calculate logs per second
    const runtimeSeconds = (Date.now() - this.getServiceStartTime()) / 1000;
    this.metrics.logsPerSecond = this.metrics.totalLogsProcessed / runtimeSeconds;
    
    // Calculate error rate
    this.metrics.errorRate = (this.metrics.failedBatches / totalBatches) * 100;
  }

  private getServiceStartTime(): number {
    return this.serviceStartTime;
  }

  // =============================================
  // ERROR HANDLING
  // =============================================

  private setupErrorHandling(): void {
    this.on('error', (error) => {
      console.error('Data Ingestion Service error:', error);
      
      // Implement error reporting/alerting here
      // Could send to monitoring services, log aggregators, etc.
    });
    
    this.on('ingestionError', ({ error, logLine }) => {
      console.error('Log ingestion error:', error);
      console.error('Failed log line:', logLine.substring(0, 200) + '...');
    });
    
    this.on('batchError', ({ error, batchSize }) => {
      console.error(`Batch processing error for ${batchSize} logs:`, error);
    });
  }

  // =============================================
  // PUBLIC API METHODS
  // =============================================

  getMetrics(): IngestionMetrics {
    return { ...this.metrics };
  }

  async getSystemHealth(): Promise<{
    ingestion: IngestionMetrics;
    database: boolean;
    cache: boolean;
    cacheMetrics: any;
  }> {
    return {
      ingestion: this.getMetrics(),
      database: await this.clickhouseClient.ping(),
      cache: await this.redisClient.ping(),
      cacheMetrics: this.redisClient.getCacheMetrics()
    };
  }

  async getTableStats(): Promise<any[]> {
    return await this.clickhouseClient.getTableStats();
  }

  async flushCache(): Promise<void> {
    await this.redisClient.flushAll();
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }

  getQueueSize(): number {
    return this.processingQueue.length;
  }

  // =============================================
  // LOG FILE PROCESSING
  // =============================================

  async processLogFile(filePath: string): Promise<void> {
    console.log(`Processing log file: ${filePath}`);
    
    // This would implement file reading and processing
    // For now, this is a placeholder that would integrate with fs.createReadStream
    
    const fs = await import('fs');
    const readline = await import('readline');
    
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    const batch: string[] = [];
    
    for await (const line of rl) {
      batch.push(line);
      
      if (batch.length >= this.config.ingestion.batchSize) {
        await this.ingestBatch(batch.splice(0, this.config.ingestion.batchSize));
      }
    }
    
    // Process remaining logs
    if (batch.length > 0) {
      await this.ingestBatch(batch);
    }
    
    console.log(`Finished processing log file: ${filePath}`);
  }
} 