import { ProcessingResult } from '../../processing/BlockProcessor';
import { Account, Block, Contract, Log, MethodSignature, Token, Transaction } from '../../model/generated';
import { StorageRoutingMode } from '../../config/AppConfig';

export interface EntityBreakdown {
  blocks: number;
  transactions: number;
  logs: number;
  accounts: number;
  methodSignatures: number;
  tokens: number;
  contracts: number;
  discoveredContracts: number;
}

export interface HotStorageBatch {
  blocks: Block[];
  transactions: Transaction[];
  logs: Log[];
  accounts: Account[];
  methodSignatures: MethodSignature[];
  tokens: Token[];
  contracts: Contract[];
  discoveredContracts: Contract[];
}

export interface SerializedBlock {
  id: string;
  number: number;
  hash: string;
  parentHash: string | null;
  timestamp: string;
  size: string;
  gasLimit: string;
  gasUsed: string;
  transactionCount: number;
  miner: string | null;
  extraData: string | null;
  baseFeePerGas: string;
}

export interface SerializedTransaction {
  hash: string;
  blockId: string;
  blockNumber: number;
  blockTimestamp: string;
  transactionIndex: number;
  fromAddress: string;
  toAddress: string | null;
  value: string;
  gas: string;
  gasPrice: string;
  gasUsed: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  input: string | null;
  status: number | null;
  nonce: string;
  type: number | null;
  methodId: string | null;
  methodName: string | null;
  isContractCreation: boolean;
  isContractInteraction: boolean;
  contractAddress: string | null;
}

export interface SerializedLog {
  id: string;
  transactionHash: string;
  blockNumber: number;
  blockTimestamp: string;
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
}

export interface ColdStorageBatch {
  batchId: string;
  producedAt: string;
  blockRange: {
    start: number;
    end: number;
  } | null;
  blocks: SerializedBlock[];
  transactions: SerializedTransaction[];
  logs: SerializedLog[];
}

export interface StorageRoutingResult {
  hot: HotStorageBatch;
  cold: ColdStorageBatch | null;
  metadata: {
    routingMode: StorageRoutingMode;
    hotEntityTotal: number;
    coldEntityTotal: number;
    hotBreakdown: EntityBreakdown;
    coldBreakdown: EntityBreakdown | null;
    latestBlockNumber: number | null;
    hotWindowStart: number | null;
  };
}

export interface IStorageRouter {
  route(result: ProcessingResult): StorageRoutingResult;
}

export interface ColdStorageMessage {
  version: number;
  payload: ColdStorageBatch;
  routingMode: StorageRoutingMode;
  hotBlockWindow: number;
  entityCounts: EntityBreakdown;
}
