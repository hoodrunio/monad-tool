/**
 * Tip Revenue Module - TypeScript Type Definitions
 */

/**
 * Raw block tip data fetched from RPC
 */
export interface BlockTipData {
  blockNumber: number;
  blockTimestamp: Date;
  validatorId: string | null;
  proposerAddress: string;
  totalTipWei: bigint;
  transactionCount: number;
  baseFeePerGas: bigint;
}

/**
 * Record for inserting into tip_revenue_raw table
 */
export interface TipRevenueRawRecord {
  block_number: number;
  block_timestamp: string;
  validator_id: string;
  proposer_address: string;
  total_tip_wei: string;
  transaction_count: number;
  base_fee_per_gas: string;
}

/**
 * Record for inserting into tip_revenue_hourly table
 */
export interface TipRevenueHourlyRecord {
  hour: string;
  validator_id: string;
  total_tip_wei: string;
  total_tip_mon: number;
  blocks_proposed: number;
  total_transactions: number;
  avg_tip_per_block_wei: string;
  avg_tip_per_tx_wei: string;
  min_tip_wei: string;
  max_tip_wei: string;
}

/**
 * Record for inserting into tip_revenue_cumulative table
 */
export interface TipRevenueCumulativeRecord {
  validator_id: string;
  total_tip_wei: string;
  total_tip_mon: number;
  total_blocks_proposed: number;
  total_transactions: number;
  avg_tip_per_block_mon: number;
  first_block_timestamp: string;
  last_block_timestamp: string;
}

/**
 * Validator tip statistics for API responses
 */
export interface ValidatorTipStats {
  validatorId: string;
  validatorName?: string;
  totalTipWei: string;
  totalTipMon: string;
  blocksProposed: number;
  totalTransactions: number;
  avgTipPerBlockWei: string;
  avgTipPerBlockMon: string;
  avgTipPerTxWei: string;
  avgTipPerTxMon: string;
  timeWindow: string;
  lastUpdated: Date;
}

/**
 * Validator tip revenue history entry (for graphs)
 */
export interface TipRevenueHistoryEntry {
  hour: string;
  totalTipMon: number;
  blocksProposed: number;
  avgTipPerBlockMon: number;
  totalTransactions: number;
}

/**
 * Network-wide tip summary
 */
export interface NetworkTipSummary {
  totalTips24hMon: string;
  avgTipPerBlockMon: string;
  totalBlocks24h: number;
  totalTransactions24h: number;
  topValidator: {
    validatorId: string;
    validatorName?: string;
    totalTipMon: string;
  } | null;
  timestamp: Date;
}

/**
 * Tip revenue ranking entry
 */
export interface TipRevenueRankingEntry {
  rank: number;
  validatorId: string;
  validatorName?: string;
  totalTipMon: string;
  blocksProposed: number;
  avgTipPerBlockMon: string;
  totalTransactions: number;
  infrastructure?: {
    provider?: string;
    location?: string;
  };
}

/**
 * Tip revenue trend data point
 */
export interface TipRevenueTrendPoint {
  hour: string;
  totalTipMon: number;
  totalBlocks: number;
  avgTipPerBlockMon: number;
  activeValidators: number;
}

/**
 * Configuration for TipRevenueSyncService
 */
export interface TipRevenueSyncConfig {
  updateIntervalMs: number;
  batchSize: number;
  rpcUrl: string;
  enableBackfill: boolean;
  backfillStartBlock: number;
}

/**
 * Sync service status
 */
export interface TipRevenueSyncStatus {
  isRunning: boolean;
  isSyncing: boolean;
  isBackfilling: boolean;
  lastProcessedBlock: number;
  currentBlock: number;
  lag: number;
  backfillProgress?: {
    startBlock: number;
    currentBlock: number;
    targetBlock: number;
    percentComplete: number;
  };
  lastSyncTime?: Date;
  errorCount: number;
}

/**
 * Wei to MON conversion constant (1 MON = 10^18 wei)
 */
export const WEI_PER_MON = BigInt('1000000000000000000');

/**
 * Convert wei to MON with specified decimal places
 */
export function weiToMon(weiAmount: bigint | string, decimals: number = 4): string {
  const wei = typeof weiAmount === 'string' ? BigInt(weiAmount) : weiAmount;
  const mon = Number(wei) / Number(WEI_PER_MON);
  return mon.toFixed(decimals);
}

/**
 * Format DateTime for ClickHouse
 */
export function formatClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Format hour for ClickHouse (truncate to hour)
 */
export function formatClickHouseHour(date: Date): string {
  const hourDate = new Date(date);
  hourDate.setMinutes(0, 0, 0);
  return hourDate.toISOString().slice(0, 19).replace('T', ' ');
}
