// Staking Event Indexer - Type Definitions
// Production-ready type system for staking precompile events

import { Log } from 'ethers';

// =============================================
// STAKING PRECOMPILE CONSTANTS
// =============================================

export const STAKING_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000001000';

// Event signatures (keccak256 of event signature)
export const EVENT_SIGNATURES = {
  ValidatorCreated: '0x3d8c9ec2e8b4b8c0e8e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5',
  ValidatorStatusChanged: '0x4d8c9ec2e8b4b8c0e8e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5b5e5',
  Delegate: '0x510b11bb3f3c799b11307c01ab7db0d335683ef5b2da98f7697de744f465eacc',
  Undelegate: '0x0f5bb82176feb1b5e747e28471aa92156a04d9f3ab9f45f28e2d704232b93f75',
  Withdraw: '0x884edad9ce6fa2440d8a54cc123490eb96d2768479d49ff9c7366125a9424364',
  ClaimRewards: '0x9310ccfcb8de723f578a9e5fbc1e5f86c8e3e1f85d2e5c73c3e5e5e5e5e5e5e5',
  CommissionChanged: '0xa31ccfcb8de723f578a9e5fbc1e5f86c8e3e1f85d2e5c73c3e5e5e5e5e5e5e5',
  ValidatorRewarded: '0xb41ccfcb8de723f578a9e5fbc1e5f86c8e3e1f85d2e5c73c3e5e5e5e5e5e5e5',
  EpochChanged: '0xc51ccfcb8de723f578a9e5fbc1e5f86c8e3e1f85d2e5c73c3e5e5e5e5e5e5e5'
} as const;

export type StakingEventType = keyof typeof EVENT_SIGNATURES;

// =============================================
// EVENT DATA STRUCTURES
// =============================================

export interface BaseStakingEvent {
  eventType: StakingEventType;
  blockNumber: number;
  blockTimestamp: Date;
  transactionHash: string;
  logIndex: number;
  epoch: bigint;
}

export interface ValidatorCreatedEvent extends BaseStakingEvent {
  eventType: 'ValidatorCreated';
  validatorId: bigint;
  authAddress: string;
  commission: bigint;
}

export interface ValidatorStatusChangedEvent extends BaseStakingEvent {
  eventType: 'ValidatorStatusChanged';
  validatorId: bigint;
  flags: bigint;
}

export interface DelegateEvent extends BaseStakingEvent {
  eventType: 'Delegate';
  validatorId: bigint;
  delegator: string;
  amount: bigint;
  activationEpoch: bigint;
}

export interface UndelegateEvent extends BaseStakingEvent {
  eventType: 'Undelegate';
  validatorId: bigint;
  delegator: string;
  withdrawId: number;
  amount: bigint;
  activationEpoch: bigint;
}

export interface WithdrawEvent extends BaseStakingEvent {
  eventType: 'Withdraw';
  validatorId: bigint;
  delegator: string;
  withdrawId: number;
  amount: bigint;
  withdrawEpoch: bigint;
}

export interface ClaimRewardsEvent extends BaseStakingEvent {
  eventType: 'ClaimRewards';
  validatorId: bigint;
  delegator: string;
  amount: bigint;
}

export interface CommissionChangedEvent extends BaseStakingEvent {
  eventType: 'CommissionChanged';
  validatorId: bigint;
  oldCommission: bigint;
  newCommission: bigint;
}

export interface ValidatorRewardedEvent extends BaseStakingEvent {
  eventType: 'ValidatorRewarded';
  validatorId: bigint;
  from: string;
  amount: bigint;
}

export interface EpochChangedEvent extends BaseStakingEvent {
  eventType: 'EpochChanged';
  oldEpoch: bigint;
  newEpoch: bigint;
}

export type StakingEvent =
  | ValidatorCreatedEvent
  | ValidatorStatusChangedEvent
  | DelegateEvent
  | UndelegateEvent
  | WithdrawEvent
  | ClaimRewardsEvent
  | CommissionChangedEvent
  | ValidatorRewardedEvent
  | EpochChangedEvent;

// =============================================
// DATABASE RECORDS
// =============================================

export interface StakingEventRecord {
  event_id: string; // Unique: txHash:logIndex
  event_type: StakingEventType;
  block_number: number;
  block_timestamp: string; // ClickHouse DateTime format
  transaction_hash: string;
  log_index: number;
  epoch: string; // Store as string for ClickHouse
  validator_id: string | null;
  delegator: string | null;
  amount: string | null;
  commission: string | null;
  old_commission: string | null;
  new_commission: string | null;
  activation_epoch: string | null;
  withdraw_id: number | null;
  flags: string | null;
  from_address: string | null;
  old_epoch: string | null;
  new_epoch: string | null;
  processed_at: string; // ClickHouse DateTime format
}

export interface ValidatorDelegationRecord {
  validator_id: string;
  delegator: string;
  current_amount: string;
  total_delegated: string;
  total_undelegated: string;
  total_withdrawn: string;
  total_rewards_claimed: string;
  pending_withdrawals: number;
  first_delegation_at: string;
  last_updated_at: string;
  last_updated_block: number;
  epoch: string;
}

export interface DelegationHistoryRecord {
  history_id: string; // Unique: txHash:logIndex
  validator_id: string;
  delegator: string;
  action: 'delegate' | 'undelegate' | 'withdraw' | 'compound';
  amount: string;
  epoch: string;
  activation_epoch: string | null;
  withdraw_id: number | null;
  block_number: number;
  block_timestamp: string;
  transaction_hash: string;
}

export interface RewardEventRecord {
  event_id: string; // Unique: txHash:logIndex
  validator_id: string;
  delegator: string | null;
  amount: string;
  epoch: string;
  event_type: 'claim' | 'commission_change' | 'validator_reward';
  old_commission: string | null;
  new_commission: string | null;
  block_number: number;
  block_timestamp: string;
  transaction_hash: string;
}

// =============================================
// EVENT LISTENER INTERFACES
// =============================================

export interface IEventListener {
  /**
   * Start listening for events
   */
  start(): Promise<void>;

  /**
   * Stop listening for events
   */
  stop(): Promise<void>;

  /**
   * Check if listener is currently active
   */
  isActive(): boolean;

  /**
   * Get listener type
   */
  getType(): 'websocket' | 'polling';

  /**
   * Subscribe to new events
   */
  onEvent(callback: (event: StakingEvent) => Promise<void>): void;

  /**
   * Subscribe to errors
   */
  onError(callback: (error: Error) => void): void;

  /**
   * Get current block lag (how far behind we are)
   */
  getCurrentLag(): number;
}

// =============================================
// EVENT PROCESSOR INTERFACES
// =============================================

export interface IEventProcessor {
  /**
   * Process a raw log and convert to typed staking event
   */
  processLog(log: Log, blockTimestamp: Date): Promise<StakingEvent | null>;

  /**
   * Batch process multiple logs
   */
  processLogs(logs: Log[], blockTimestamps: Map<number, Date>): Promise<StakingEvent[]>;
}

export interface IEventDeduplicator {
  /**
   * Check if event has been processed
   */
  isDuplicate(eventId: string): Promise<boolean>;

  /**
   * Mark event as processed
   */
  markProcessed(eventId: string): Promise<void>;

  /**
   * Batch mark multiple events as processed
   */
  markBatchProcessed(eventIds: string[]): Promise<void>;

  /**
   * Clear old entries (cleanup)
   */
  cleanup(olderThanBlocks: number): Promise<void>;
}

// =============================================
// CONFIGURATION
// =============================================

export interface StakingEventIndexerConfig {
  rpcUrl: string;
  wsUrl?: string;
  startBlock?: number;
  pollingInterval?: number; // milliseconds
  batchSize?: number; // number of blocks to fetch in one getLogs call
  reconnectDelay?: number; // milliseconds
  maxReconnectAttempts?: number;
  enableWebSocket?: boolean;
  enablePolling?: boolean;
}

// =============================================
// LISTENER STATE
// =============================================

export interface ListenerState {
  type: 'websocket' | 'polling' | 'stopped';
  isActive: boolean;
  lastProcessedBlock: number;
  currentBlock: number;
  lag: number;
  errorCount: number;
  lastError: string | null;
  startedAt: Date | null;
  reconnectAttempts?: number;
}

// =============================================
// METRICS
// =============================================

export interface IndexerMetrics {
  eventsProcessed: number;
  eventsSkipped: number;
  eventsFailed: number;
  currentBlock: number;
  lastProcessedBlock: number;
  lag: number;
  listenerType: 'websocket' | 'polling' | 'stopped';
  uptime: number; // seconds
  averageProcessingTime: number; // milliseconds
  errorRate: number; // errors per minute
}

// =============================================
// ERROR TYPES
// =============================================

export class StakingEventError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, any>
  ) {
    super(message);
    this.name = 'StakingEventError';
  }
}

export class EventProcessingError extends StakingEventError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'EVENT_PROCESSING_ERROR', context);
    this.name = 'EventProcessingError';
  }
}

export class ListenerConnectionError extends StakingEventError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'LISTENER_CONNECTION_ERROR', context);
    this.name = 'ListenerConnectionError';
  }
}

export class DeduplicationError extends StakingEventError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'DEDUPLICATION_ERROR', context);
    this.name = 'DeduplicationError';
  }
}
