// Staking Event Indexer - Type Definitions
// Production-ready type system for staking precompile events

import { Log } from 'ethers';

// =============================================
// STAKING PRECOMPILE CONSTANTS
// =============================================

export const STAKING_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000001000';

// Event signatures (keccak256 of event signature)
export const EVENT_SIGNATURES = {
  ValidatorCreated: '0x6f8045cd38e512b8f12f6f02947c632e5f25af03aad132890ecf50015d97c1b2',
  ValidatorStatusChanged: '0x53fea97d222a32adefa819a8c0458efa5c2d28d52edd73d970f09a352efc241c',
  Delegate: '0xe4d4df1e1827dd28252fd5c3cd7ebccd3da6e0aa31f74c828f3c8542af49d840',
  Undelegate: '0x3e53c8b91747e1b72a44894db10f2a45fa632b161fdcdd3a17bd6be5482bac62',
  Withdraw: '0x63030e4238e1146c63f38f4ac81b2b23c8be28882e68b03f0887e50d0e9bb18f',
  ClaimRewards: '0x3170ba953fe3e068954fcbc93913a05bf457825d4d4d86ec9b72ce2186cd8109',
  CommissionChanged: '0xd1698d3454c5b5384b70aaae33f1704af7c7e055f0c75503ba3146dc28995920',
  ValidatorRewarded: '0xcd427adadd397bb451e509d89a641d460fb5e0e6fb30fa89ed48f6681bad0551',
  EpochChanged: '0x4fae4dbe0ed659e8ce6637e3c273cd8e4d3bf029b9379a9e8b3f3f27dbef809b'
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
