// Monad Validator Analytics - Systemd Log Streaming Service
// Provides real-time log streaming from systemd/journalctl for production deployment

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { DataIngestionService } from './data-ingestion';
import { logger } from '../utils/logger';

export interface SystemdLogStreamConfig {
  serviceNames: string[]; // Array of systemd service names (e.g., ['monad-bft', 'monad-ledger-tail'])
  followMode: boolean; // Whether to follow logs in real-time
  sinceWhen?: string; // When to start reading from (e.g., '2 hours ago', 'today')
  includeKernelMessages?: boolean;
  outputFormat: 'json' | 'cat' | 'short' | 'verbose';
  priority?: 'emerg' | 'alert' | 'crit' | 'err' | 'warning' | 'notice' | 'info' | 'debug';
  maxLines?: number; // Maximum number of lines to read initially
  bufferSize: number; // Buffer size for processing
  restartOnFailure: boolean;
  maxRestartAttempts: number;
  restartDelayMs: number;
}

export interface SystemdLogStreamMetrics {
  linesProcessed: number;
  linesPerSecond: number;
  lastLogTime: Date;
  restartCount: number;
  uptime: number;
  isConnected: boolean;
  bufferUsage: number;
  activeServices: string[]; // Track which services are currently being monitored
}

export class SystemdLogStream extends EventEmitter {
  private config: SystemdLogStreamConfig;
  private ingestionService: DataIngestionService;
  private journalProcesses: Map<string, ChildProcess> = new Map(); // Multiple processes, one per service
  private isRunning: boolean = false;
  private buffer: string[] = [];
  private metrics: SystemdLogStreamMetrics;
  private startTime: number = 0;
  private restartTimers: Map<string, NodeJS.Timeout> = new Map(); // Separate restart timers per service

  constructor(config: SystemdLogStreamConfig, ingestionService: DataIngestionService) {
    super();
    this.config = config;
    this.ingestionService = ingestionService;
    
    this.metrics = {
      linesProcessed: 0,
      linesPerSecond: 0,
      lastLogTime: new Date(),
      restartCount: 0,
      uptime: 0,
      isConnected: false,
      bufferUsage: 0,
      activeServices: []
    };

    this.setupErrorHandling();
  }

  // =============================================
  // SYSTEMD LOG STREAMING
  // =============================================

  async start(): Promise<void> {
    logger.info(`Starting systemd log stream for services: ${this.config.serviceNames.join(', ')}`);
    
    try {
      this.startTime = Date.now();
      this.isRunning = true;
      
      // Start journalctl for each service
      for (const serviceName of this.config.serviceNames) {
        await this.startJournalctlForService(serviceName);
      }
      
      // Start metrics collection
      this.startMetricsCollection();
      
      logger.info(`Systemd log stream started successfully for ${this.config.serviceNames.length} services`);
      this.emit('started');
    } catch (error) {
      logger.error('Failed to start systemd log stream:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info('Stopping systemd log stream...');
    
    this.isRunning = false;
    
    // Clear all restart timers
    for (const [serviceName, timer] of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
    
    // Stop all journal processes
    for (const [serviceName, process] of this.journalProcesses) {
      process.kill('SIGTERM');
      logger.info(`Stopped journalctl process for ${serviceName}`);
    }
    this.journalProcesses.clear();
    
    // Process remaining buffer
    if (this.buffer.length > 0) {
      await this.flushBuffer();
    }
    
    this.metrics.isConnected = false;
    this.metrics.activeServices = [];
    
    logger.info('Systemd log stream stopped');
    this.emit('stopped');
  }

  private async startJournalctlForService(serviceName: string): Promise<void> {
    const args = this.buildJournalctlArgs(serviceName);
    
    logger.info(`Starting journalctl for ${serviceName} with args: ${args.join(' ')}`);
    
    const journalProcess = spawn('journalctl', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    journalProcess.stdout?.setEncoding('utf8');
    journalProcess.stderr?.setEncoding('utf8');

    // Handle stdout data
    journalProcess.stdout?.on('data', (data: string) => {
      this.processLogData(data, serviceName);
    });

    // Handle stderr
    journalProcess.stderr?.on('data', (data: string) => {
      const stderrMessage = data.toString().trim();
      logger.warn(`journalctl stderr for ${serviceName}: ${stderrMessage}`);
    });

    // Handle process events
    journalProcess.on('close', (code: number | null) => {
      logger.warn(`journalctl process for ${serviceName} closed with code: ${code}`);
      this.journalProcesses.delete(serviceName);
      this.updateConnectionStatus();
      
      if (this.isRunning && this.config.restartOnFailure) {
        this.scheduleRestart(serviceName);
      }
    });

    journalProcess.on('error', (error: Error) => {
      logger.error(`journalctl process error for ${serviceName}:`, error);
      this.journalProcesses.delete(serviceName);
      this.updateConnectionStatus();
      this.emit('error', error);
      
      if (this.isRunning && this.config.restartOnFailure) {
        this.scheduleRestart(serviceName);
      }
    });

    // Store the process
    this.journalProcesses.set(serviceName, journalProcess);

    // Wait a moment to ensure process started
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (journalProcess && !journalProcess.killed) {
      this.updateConnectionStatus();
      logger.info(`journalctl process for ${serviceName} started successfully`);
    } else {
      throw new Error(`Failed to start journalctl process for ${serviceName}`);
    }
  }

  private buildJournalctlArgs(serviceName: string): string[] {
    const args: string[] = [];
    
    // Add service filter
    args.push('-u', serviceName);
    
    // Add output format
    args.push('-o', this.config.outputFormat);
    
    // Add follow mode if enabled
    if (this.config.followMode) {
      args.push('-f');
    }
    
    // Add since filter if specified
    if (this.config.sinceWhen) {
      args.push('--since', this.config.sinceWhen);
    }
    
    // Add priority filter if specified
    if (this.config.priority) {
      args.push('-p', this.config.priority);
    }
    
    // Add max lines if specified and not in follow mode
    if (this.config.maxLines && !this.config.followMode) {
      args.push('-n', this.config.maxLines.toString());
    }
    
    // Add kernel messages if enabled
    if (this.config.includeKernelMessages) {
      args.push('--dmesg');
    }
    
    // Force line buffering
    args.push('--lines', '0');
    
    return args;
  }

  private processLogData(data: string, serviceName: string): void {
    const lines = data.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      // Tag the line with the service name for processing
      const taggedLine = this.tagLineWithService(line, serviceName);
      this.buffer.push(taggedLine);
      this.metrics.linesProcessed++;
      this.metrics.lastLogTime = new Date();
      
      // Process buffer when it reaches configured size
      if (this.buffer.length >= this.config.bufferSize) {
        this.flushBuffer();
      }
    }
    
    this.updateBufferMetrics();
  }

  private tagLineWithService(logLine: string, serviceName: string): string {
    try {
      // If it's already JSON from journalctl, convert to RawLog format
      if (logLine.trim().startsWith('{')) {
        const journalEntry = JSON.parse(logLine);
        
        // Check if this is a journalctl JSON entry with MESSAGE field
        if (journalEntry.MESSAGE) {
          // Try to parse the MESSAGE field as JSON (actual log content)
          try {
            const actualLog = JSON.parse(journalEntry.MESSAGE);
            
            // Convert to RawLog format expected by MonadLogProcessor
            return JSON.stringify({
              timestamp: actualLog.timestamp || new Date(parseInt(journalEntry.__REALTIME_TIMESTAMP || '0') / 1000).toISOString(),
              level: actualLog.level || 'INFO',
              fields: actualLog.fields || {},
              target: actualLog.target || this.getTargetFromService(serviceName)
            });
          } catch (e) {
            // MESSAGE is not JSON, treat as plain text message
            return JSON.stringify({
              timestamp: new Date(parseInt(journalEntry.__REALTIME_TIMESTAMP || '0') / 1000).toISOString(),
              level: 'INFO',
              fields: {
                message: journalEntry.MESSAGE
              },
              target: this.getTargetFromService(serviceName)
            });
          }
        } else {
          // Already in the expected format, just add service info if needed
          const logObject = { ...journalEntry };
          if (!logObject.target) {
            logObject.target = this.getTargetFromService(serviceName);
          }
          return JSON.stringify(logObject);
        }
      } else {
        // For non-JSON lines, create RawLog format
        return JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'INFO',
          fields: {
            message: logLine
          },
          target: this.getTargetFromService(serviceName)
        });
      }
    } catch (error) {
      // If parsing fails, create a simple RawLog format
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        fields: {
          message: logLine
        },
        target: this.getTargetFromService(serviceName)
      });
    }
  }

  private getTargetFromService(serviceName: string): string {
    // Map service names to expected targets
    switch (serviceName) {
      case 'monad-bft':
        return 'monad_consensus_state';
      case 'monad-ledger-tail':
        return 'ledger_tail';
      default:
        return serviceName.replace('-', '_');
    }
  }

  private updateConnectionStatus(): void {
    const activeServices = Array.from(this.journalProcesses.keys());
    this.metrics.activeServices = activeServices;
    this.metrics.isConnected = activeServices.length > 0;
  }

  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    const linesToProcess = this.buffer.splice(0);
    
    try {
      // Send to ingestion service
      await this.ingestionService.ingestBatch(linesToProcess);
      
      this.emit('batchProcessed', {
        linesProcessed: linesToProcess.length,
        timestamp: new Date()
      });
    } catch (error) {
      logger.error('Failed to process log buffer:', error);
      this.emit('bufferError', { error, linesLost: linesToProcess.length });
    }
    
    this.updateBufferMetrics();
  }

  private scheduleRestart(serviceName: string): void {
    if (this.metrics.restartCount >= this.config.maxRestartAttempts) {
      logger.error(`Max restart attempts (${this.config.maxRestartAttempts}) reached for ${serviceName}. Stopping.`);
      return;
    }
    
    this.metrics.restartCount++;
    const delay = this.config.restartDelayMs * Math.pow(2, this.metrics.restartCount - 1); // Exponential backoff
    
    logger.info(`Scheduling restart attempt ${this.metrics.restartCount} for ${serviceName} in ${delay}ms`);
    
    const timer = setTimeout(async () => {
      try {
        await this.startJournalctlForService(serviceName);
        this.restartTimers.delete(serviceName);
      } catch (error) {
        logger.error(`Restart attempt failed for ${serviceName}:`, error);
        this.scheduleRestart(serviceName);
      }
    }, delay);
    
    this.restartTimers.set(serviceName, timer);
  }

  // =============================================
  // METRICS AND MONITORING
  // =============================================

  private startMetricsCollection(): void {
    setInterval(() => {
      this.updateMetrics();
      this.emit('metricsUpdated', this.getMetrics());
    }, 10000); // Update every 10 seconds
  }

  private updateMetrics(): void {
    const now = Date.now();
    this.metrics.uptime = now - this.startTime;
    
    // Calculate lines per second over the last 10 seconds
    const timeWindow = 10000; // 10 seconds
    this.metrics.linesPerSecond = this.metrics.linesProcessed / (this.metrics.uptime / 1000);
  }

  private updateBufferMetrics(): void {
    this.metrics.bufferUsage = (this.buffer.length / this.config.bufferSize) * 100;
  }

  getMetrics(): SystemdLogStreamMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  // =============================================
  // ERROR HANDLING
  // =============================================

  private setupErrorHandling(): void {
    this.on('error', (error) => {
      logger.error('SystemdLogStream error:', error);
    });
    
    this.on('bufferError', ({ error, linesLost }) => {
      logger.error(`Buffer processing error, lost ${linesLost} lines:`, error);
    });
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  isConnected(): boolean {
    return this.metrics.isConnected && this.journalProcesses.size > 0;
  }

  getActiveServices(): string[] {
    return this.metrics.activeServices;
  }

  getServiceStatus(): Map<string, boolean> {
    const status = new Map<string, boolean>();
    for (const serviceName of this.config.serviceNames) {
      const process = this.journalProcesses.get(serviceName);
      status.set(serviceName, process !== undefined && !process.killed);
    }
    return status;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  async forceFlush(): Promise<void> {
    await this.flushBuffer();
  }

  // =============================================
  // LOG FILE FALLBACK PROCESSING
  // =============================================

  async processLogFile(filePath: string): Promise<void> {
    logger.info(`Processing log file: ${filePath}`);
    
    const fileStream = createReadStream(filePath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    const batch: string[] = [];
    
    for await (const line of rl) {
      batch.push(line);
      
      if (batch.length >= this.config.bufferSize) {
        await this.ingestionService.ingestBatch(batch.splice(0, this.config.bufferSize));
      }
    }
    
    // Process remaining logs
    if (batch.length > 0) {
      await this.ingestionService.ingestBatch(batch);
    }
    
    logger.info(`Finished processing log file: ${filePath}`);
  }
} 