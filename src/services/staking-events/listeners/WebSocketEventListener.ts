// WebSocket Event Listener
// Real-time event listening with automatic reconnection and heartbeat monitoring

import { ethers, WebSocketProvider, Log } from 'ethers';
import { logger } from '../../../utils/logger';
import {
  IEventListener,
  STAKING_PRECOMPILE_ADDRESS,
  ListenerConnectionError
} from '../types';

interface WebSocketConfig {
  wsUrl: string;
  reconnectDelay?: number; // milliseconds
  maxReconnectAttempts?: number;
  heartbeatInterval?: number; // milliseconds
}

/**
 * Production-ready WebSocket Event Listener
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Heartbeat monitoring
 * - Connection state tracking
 * - Graceful shutdown
 */
export class WebSocketEventListener implements IEventListener {
  private provider: WebSocketProvider | null = null;
  private config: WebSocketConfig;
  private _isActive = false;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastHeartbeat: Date | null = null;

  // Callbacks
  private eventCallback: ((log: Log) => Promise<void>) | null = null;
  private errorCallback: ((error: Error) => void) | null = null;

  // State tracking
  private currentBlock = 0;
  private lastProcessedBlock = 0;

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnectDelay: 5000,
      maxReconnectAttempts: 10,
      heartbeatInterval: 30000,
      ...config
    };

    logger.info('WebSocketEventListener initialized', {
      wsUrl: this.config.wsUrl,
      reconnectDelay: this.config.reconnectDelay,
      maxReconnectAttempts: this.config.maxReconnectAttempts
    });
  }

  /**
   * Start listening for events
   */
  async start(): Promise<void> {
    if (this._isActive) {
      logger.warn('WebSocket listener already active');
      return;
    }

    logger.info('Starting WebSocket listener...');

    try {
      await this.connect();
      this._isActive = true;
      this.startHeartbeat();

      logger.info('WebSocket listener started successfully');
    } catch (error) {
      this._isActive = false;
      throw new ListenerConnectionError(
        `Failed to start WebSocket listener: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { wsUrl: this.config.wsUrl }
      );
    }
  }

  /**
   * Stop listening for events
   */
  async stop(): Promise<void> {
    logger.info('Stopping WebSocket listener...');

    this._isActive = false;

    // Clear timers
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Disconnect
    await this.disconnect();

    logger.info('WebSocket listener stopped');
  }

  /**
   * Check if listener is currently active
   */
  isActive(): boolean {
    return this._isActive && this.provider !== null;
  }

  /**
   * Get listener type
   */
  getType(): 'websocket' | 'polling' {
    return 'websocket';
  }

  /**
   * Subscribe to new events
   */
  onEvent(callback: (log: Log) => Promise<void>): void {
    this.eventCallback = callback;
  }

  /**
   * Subscribe to errors
   */
  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  /**
   * Get current block lag
   */
  getCurrentLag(): number {
    return this.currentBlock - this.lastProcessedBlock;
  }

  /**
   * Connect to WebSocket
   */
  private async connect(): Promise<void> {
    try {
      logger.info('Connecting to WebSocket...', { wsUrl: this.config.wsUrl });

      // Create WebSocket provider
      this.provider = new ethers.WebSocketProvider(this.config.wsUrl);

      // Setup event listeners
      this.setupProviderListeners();

      // Subscribe to staking contract logs
      await this.subscribeToLogs();

      // Track current block
      this.provider.on('block', (blockNumber: number) => {
        this.currentBlock = blockNumber;
        this.lastHeartbeat = new Date();
        logger.debug('New block', { blockNumber });
      });

      // Reset reconnect attempts on successful connection
      this.reconnectAttempts = 0;

      logger.info('WebSocket connected successfully');
    } catch (error) {
      throw new ListenerConnectionError(
        `WebSocket connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { wsUrl: this.config.wsUrl }
      );
    }
  }

  /**
   * Disconnect from WebSocket
   */
  private async disconnect(): Promise<void> {
    if (this.provider) {
      try {
        // Remove all listeners
        this.provider.removeAllListeners();

        // Destroy provider
        await this.provider.destroy();
        this.provider = null;

        logger.info('WebSocket disconnected');
      } catch (error) {
        logger.error('Error during disconnect', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  /**
   * Setup provider event listeners
   */
  private setupProviderListeners(): void {
    if (!this.provider) return;

    // ethers v6 does not emit 'close' or 'error' ProviderEvents.
    // Use the 'debug' channel to detect reconnect/close/error scenarios.
    type ProviderDebugEvent = {
      action: string;
      reason?: unknown;
      [key: string]: unknown;
    };

    this.provider.on('debug', (debugEvent: ProviderDebugEvent) => {
      const action = String(debugEvent.action || '');

      if (action === 'reconnect') {
        logger.warn('WebSocket provider reconnect detected', {
          reconnectAttempts: this.reconnectAttempts
        });
        // Let ethers handle reconnect internally; we just log it
        return;
      }

      if (action === 'close' || action === 'error') {
        const reason = typeof debugEvent.reason === 'string' ? debugEvent.reason : undefined;
        logger.warn('WebSocket provider debug event indicates close/error', {
          action,
          reason,
          reconnectAttempts: this.reconnectAttempts
        });

        if (this.errorCallback) {
          this.errorCallback(new Error(`WebSocket provider ${action}${reason ? `: ${reason}` : ''}`));
        }

        // Trigger our reconnection logic
        this.handleDisconnection();
      }
    });
  }

  /**
   * Subscribe to staking precompile logs
   */
  private async subscribeToLogs(): Promise<void> {
    if (!this.provider) {
      throw new Error('Provider not initialized');
    }

    const filter = {
      address: STAKING_PRECOMPILE_ADDRESS
    };

    logger.info('Subscribing to staking contract logs...', { address: STAKING_PRECOMPILE_ADDRESS });

    this.provider.on(filter, async (log: Log) => {
      try {
        this.lastProcessedBlock = log.blockNumber;

        logger.debug('Received log', {
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index
        });

        // Forward raw log to indexer for processing
        if (this.eventCallback) {
          await this.eventCallback(log);
        }
      } catch (error) {
        logger.error('Error processing log', {
          error: error instanceof Error ? error.message : 'Unknown error',
          transactionHash: log.transactionHash
        });

        if (this.errorCallback) {
          this.errorCallback(
            error instanceof Error ? error : new Error('Unknown error processing log')
          );
        }
      }
    });

    logger.info('Successfully subscribed to staking contract logs');
  }

  /**
   * Handle disconnection and trigger reconnection
   */
  private handleDisconnection(): void {
    if (!this._isActive) {
      return; // Don't reconnect if we're intentionally stopped
    }

    if (this.reconnectAttempts >= (this.config.maxReconnectAttempts || 10)) {
      logger.error('Max reconnection attempts reached, giving up', {
        attempts: this.reconnectAttempts
      });

      this._isActive = false;

      if (this.errorCallback) {
        this.errorCallback(new Error('Max WebSocket reconnection attempts reached'));
      }

      return;
    }

    // Exponential backoff
    const delay = Math.min(
      (this.config.reconnectDelay || 5000) * Math.pow(2, this.reconnectAttempts),
      60000 // Max 60 seconds
    );

    this.reconnectAttempts++;

    logger.info('Scheduling reconnection...', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.config.maxReconnectAttempts,
      delayMs: delay
    });

    this.reconnectTimeout = setTimeout(() => {
      this.reconnect().catch((error) => {
        logger.error('Reconnection failed', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      });
    }, delay);
  }

  /**
   * Reconnect to WebSocket
   */
  private async reconnect(): Promise<void> {
    try {
      logger.info('Attempting to reconnect...', {
        attempt: this.reconnectAttempts
      });

      // Disconnect old provider
      await this.disconnect();

      // Connect new provider
      await this.connect();

      logger.info('Reconnection successful', {
        attempts: this.reconnectAttempts
      });
    } catch (error) {
      logger.error('Reconnection attempt failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        attempt: this.reconnectAttempts
      });

      // Try again
      this.handleDisconnection();
    }
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    const interval = this.config.heartbeatInterval || 30000;

    this.heartbeatInterval = setInterval(() => {
      if (!this._isActive || !this.provider) {
        return;
      }

      const now = new Date();
      const lastHeartbeatAge = this.lastHeartbeat
        ? now.getTime() - this.lastHeartbeat.getTime()
        : Infinity;

      // If no heartbeat in 2x the interval, consider connection dead
      if (lastHeartbeatAge > interval * 2) {
        logger.warn('Heartbeat timeout detected, triggering reconnection', {
          lastHeartbeatAge,
          threshold: interval * 2
        });

        this.handleDisconnection();
      } else {
        logger.debug('Heartbeat OK', {
          lastHeartbeatAge,
          currentBlock: this.currentBlock,
          lag: this.getCurrentLag()
        });
      }
    }, interval);

    logger.info('Heartbeat monitoring started', { intervalMs: interval });
  }

  /**
   * Get connection state
   */
  getState() {
    return {
      isActive: this._isActive,
      reconnectAttempts: this.reconnectAttempts,
      currentBlock: this.currentBlock,
      lastProcessedBlock: this.lastProcessedBlock,
      lag: this.getCurrentLag(),
      lastHeartbeat: this.lastHeartbeat,
      provider: this.provider !== null
    };
  }
}
