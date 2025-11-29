// Monad Validator Analytics - Advanced Log Processing Types
// Based on comprehensive Phase 1 log analysis
// Supports 15+ event types, QC participation, vote chains, geographic intelligence

// =============================================
// RAW LOG TYPES
// =============================================

export interface RawLog {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  fields: Record<string, any>;
  target: string;
}

export interface ParsedLogMeta {
  ingestionId: string;
  parsedAt: Date;
  parsingStatus: 'pending' | 'success' | 'failed' | 'partial';
  parsingError?: string;
}

// =============================================
// ENHANCED EVENT TYPES
// =============================================

export enum EventType {
  // Consensus events (1-10)
  VOTE_ATTEMPT = 'vote_attempt',
  VOTE_RESULT = 'vote_result', 
  VOTE_CREATED = 'vote_created',
  PROPOSAL_RECEIVED = 'proposal_received',
  PROPOSAL_DETAILED = 'proposal_detailed',
  PROPOSAL_VALIDATED = 'proposal_validated',
  QC_COMMIT_ATTEMPT = 'qc_commit_attempt',
  QC_COMMIT_TRIGGERED = 'qc_commit_triggered',
  
  // Block events (10-20)
  BLOCK_PROPOSAL = 'block_proposal',
  BLOCK_COMMITTED = 'block_committed',
  BLOCK_SKIPPED = 'block_skipped',
  BLOCK_SEQUENCE_COMMITTED = 'block_sequence_committed',
  
  // Transaction events (20-30)
  TXPOOL_UPDATED = 'txpool_updated',
  
  // System events (30-40)
  TELEMETRY_EXPORT = 'telemetry_export',
  METRICS_COLLECTED = 'metrics_collected'
}

// =============================================
// QC PARTICIPATION TYPES
// =============================================

export interface QCParticipationData {
  timestamp: Date;
  roundNumber: number;
  epochNumber: number;
  participantCount: number;
  participationRate: number;
  validatorId: string;
  qcId: string;
  blockId: string;
  processingLatencyMs: number;
  // Additional fields for ClickHouse storage
  totalValidators: number;
  participatingValidators: number;
  participationBitmap: string;
  blsSignature: string;
  signatureVerificationTimeNs?: number;
  qcAssemblyTimeMs: number;
  validatorParticipation: Array<{
    validatorId: string;
    participated: boolean;
  }>;
}

export interface QCData {
  info: VoteInfo;
  sigs: BlsSignatureCollection;
}

export interface BlsSignatureCollection {
  signers: SignerMap;
  sig: string; // BLS signature
}

export interface SignerMap {
  addr: string;
  head: string;
  bits: number;
  capacity: number;
  bitmap: number[]; // BitVec array
}

// =============================================
// VOTE CHAIN TYPES
// =============================================

export interface VoteInfo {
  validatorId: string;
  voteType: string;
  timestamp: Date;
  successful: boolean;
  processingDelayMs: number;
}

export interface VoteChain {
  chainId: string;
  roundNumber: number;
  epochNumber: number;
  votes: VoteInfo[];
  startTime: Date;
  endTime: Date;
  totalVotes: number;
  successfulVotes: number;
}

// =============================================
// VALIDATOR INFRASTRUCTURE TYPES
// =============================================

export interface ValidatorInfrastructure {
  validatorId: string;
  dnsName: string;
  geographicRegion: string;
  infrastructureProvider: string;
  datacenterCode: string;
  providerType: 'monadinfra' | 'community' | 'enterprise';
  endpointHost: string;
  endpointPort: number;
}

export interface DNSParseResult {
  provider: string;
  network: string;
  tier: string;
  type: string;
  region: string;
  location: string;
  instance: string;
  domain: string;
  port: number;
}

// =============================================
// CONSENSUS EVENT TYPES
// =============================================

export interface ConsensusEvent {
  timestamp: Date;
  eventType: EventType;
  validatorId: string;
  roundNumber: number;
  epochNumber: number;
  blockNumber?: number;
  blockId?: string;
  
  // Vote chain relationships
  parentVoteId?: string;
  parentRound?: number;
  nextLeaderId?: string;
  
  // Timing data
  blockTimestampMs?: number;
  processingTimestampMs: number;
  processingDelayMs: number;
  
  // Proposal metadata
  transactionCount: number;
  stateRootAction?: string;
  sequenceNumber?: number;
  
  // Geographic and infrastructure
  validatorDns: string;
  geographicRegion: string;
  infrastructureProvider: string;
  datacenterCode: string;
  
  // Performance metrics
  isSuccessful: boolean;
  participantCount?: number;
  participationRate?: number;
  
  // Raw metadata
  metadata: string;
  
  // Processing metadata
  ingestionId: string;
}

// =============================================
// LEDGER EVENT TYPES
// =============================================

export interface LedgerEvent {
  timestamp: Date;
  eventType: EventType;
  validatorId: string;
  roundNumber: number;
  epochNumber: number;
  blockNumber?: number;
  
  // Ledger-specific fields
  parentRound?: number;
  sequenceNumber?: number;
  transactionCount: number;
  
  // Timing analysis
  blockTimestampMs: number;
  processingTimestampMs: number;
  processingDelayMs: number;
  
  // Infrastructure
  validatorDns: string;
  geographicRegion: string;
  infrastructureProvider: string;
  datacenterCode: string;
  
  // Processing metadata
  ingestionId: string;
}

// =============================================
// PARSED EVENT UNION
// =============================================

export type ParsedEvent = ConsensusEvent | LedgerEvent;

// =============================================
// PROCESSING INTERFACES
// =============================================

export interface LogProcessingResult {
  consensusEvents: ConsensusEvent[];
  ledgerEvents: LedgerEvent[];
  qcParticipationData: QCParticipationData[];
  voteChains: VoteChain[];
  validatorInfrastructure: ValidatorInfrastructure[];
  errors: string[];
  processingTimeMs: number;
  processedLogs: number;
  successfullyParsed: number;
}

export interface ProcessingError {
  logContent: string;
  error: string;
  timestamp: Date;
  ingestionId: string;
}

export interface ProcessingStats {
  totalLogs: number;
  successfullyParsed: number;
  partiallyParsed: number;
  failed: number;
  processingTimeMs: number;
  eventsGenerated: number;
  qcDataExtracted: number;
  voteChainsConstruted: number;
}

// =============================================
// PARSER INTERFACES
// =============================================

export interface EnhancedLogProcessor {
  parseConsensusEvents(logs: RawLog[]): ConsensusEvent[];
  parseLedgerEvents(logs: RawLog[]): LedgerEvent[];
  extractQCParticipation(qcData: string): QCParticipationData;
  parseValidatorInfrastructure(dns: string): ValidatorInfrastructure;
  buildVoteChain(voteEvents: VoteInfo[]): VoteChain[];
  processBatch(logs: RawLog[]): Promise<LogProcessingResult>;
}

export interface QCParticipationParser {
  parseBitVec(bitVecString: string): number[];
  extractParticipation(qcString: string, epoch?: number): QCParticipationData;
  calculateParticipationRate(participating: number, total: number): number;
  mapValidatorPositions(bitmap: number[], epoch?: number): Array<{
    validatorId: string;
    nodeId: string;
    participated: boolean;
    position: number;
    stake: number;
  }>;
}

export interface DNSIntelligenceParser {
  parseDNS(dnsString: string): DNSParseResult;
  extractGeographicRegion(dns: string): string;
  extractInfrastructureProvider(dns: string): string;
  extractDatacenterCode(dns: string): string;
  classifyProviderType(provider: string): 'monadinfra' | 'community' | 'enterprise';
}

export interface VoteChainBuilder {
  extractVoteInfo(voteString: string): VoteInfo;
  buildChain(votes: VoteInfo[]): VoteChain[];
  findParentVote(vote: VoteInfo, previousVotes: VoteInfo[]): VoteInfo | null;
  validateChainIntegrity(chain: VoteChain[]): boolean;
}

// =============================================
// CONFIGURATION TYPES
// =============================================

export interface ProcessingConfig {
  batchSize: number;
  batchTimeoutMs: number;
  maxRetries: number;
  enableQCParsing: boolean;
  enableVoteChainAnalysis: boolean;
  enableGeographicIntelligence: boolean;
  parallelProcessing: boolean;
  maxConcurrentBatches: number;
  preProcessDNS?: boolean; // Optional DNS pre-processing flag
}

export interface GeographicMapping {
  [region: string]: {
    fullName: string;
    country: string;
    continent: string;
    timezone: string;
  };
}

// =============================================
// PERFORMANCE MONITORING TYPES
// =============================================

export interface ProcessingMetrics {
  timestamp: Date;
  batchId: string;
  processingTimeMs: number;
  logsProcessed: number;
  eventsGenerated: number;
  qcDataExtracted: number;
  errorCount: number;
  memoryUsageMb: number;
  throughputLogsPerSecond: number;
}

export interface ParsingPerformance {
  consensusEventsParsed: number;
  ledgerEventsParsed: number;
  qcParticipationExtracted: number;
  voteChainSegments: number;
  dnsIntelligenceParsed: number;
  averageProcessingTimeMs: number;
  errorRate: number;
}

// =============================================
// ERROR HANDLING TYPES
// =============================================

export interface ParsingErrorDetails {
  errorType: 'json_parse' | 'field_missing' | 'invalid_format' | 'qc_parse_error' | 'dns_parse_error';
  fieldName?: string;
  expectedFormat?: string;
  actualValue?: any;
  stackTrace?: string;
}

export interface RecoveryStrategy {
  retryCount: number;
  fallbackParsing: boolean;
  partialDataAcceptance: boolean;
  errorReporting: boolean;
}

// =============================================
// EXPORT UTILITIES
// =============================================

export const EventTypeMapping: Record<string, EventType> = {
  'try vote': EventType.VOTE_ATTEMPT,
  'vote result': EventType.VOTE_RESULT,
  'created vote': EventType.VOTE_CREATED,
  'received proposal': EventType.PROPOSAL_RECEIVED,
  'proposal message': EventType.PROPOSAL_DETAILED,
  'Received Proposal Message with valid state root hash': EventType.PROPOSAL_VALIDATED,
  'try committing blocks using qc': EventType.QC_COMMIT_ATTEMPT,
  'qc triggered commit': EventType.QC_COMMIT_TRIGGERED,
  'proposed_block': EventType.BLOCK_PROPOSAL,
  'finalized_block': EventType.BLOCK_COMMITTED,
  'committed block': EventType.BLOCK_COMMITTED,
  'timeout': EventType.BLOCK_SKIPPED,
  'base seq num committed': EventType.BLOCK_SEQUENCE_COMMITTED,
  'txpool updating committed block': EventType.TXPOOL_UPDATED
};

// =============================================
// SEPARATE VALIDATOR METRICS TYPES (NEW)
// =============================================

export interface BlockProposalEvent {
  timestamp: Date;
  validatorId: string;
  seqNum: number;
  roundNumber: number;
  epochNumber: number;
  status: 'proposed' | 'skipped';
  numTx: number;
  blockId?: string;
  
  // Infrastructure data
  validatorDns: string;
  geographicRegion: string;
  infrastructureProvider: string;
  
  // Processing metadata
  ingestionId: string;
}

export interface QCParticipationEvent {
  timestamp: Date;
  validatorId: string;
  seqNum: number;
  roundNumber: number;
  epochNumber: number;
  participated: boolean;
  validatorIndex: number;
  
  // QC metadata
  qcId: string;
  totalValidators: number;
  participatingValidators: number;
  participationRate: number;
  
  // Infrastructure data
  validatorDns: string;
  geographicRegion: string;
  infrastructureProvider: string;
  
  // Processing metadata
  ingestionId: string;
}

export interface SeparateValidatorMetrics {
  hour: Date;
  validatorId: string;
  
  // Metric 1: Block Proposal Ratio
  blocksProposed: number;
  blocksSkipped: number;
  blockProposalRatio: number;
  
  // Metric 2: QC Participation Rate
  qcParticipations: number;
  totalBlocksWithQc: number;
  qcParticipationRate: number;
  
  // Metric 3: Combined Uptime Summary
  uptimeSummary: number;
  
  // Infrastructure metadata
  geographicRegion: string;
  infrastructureProvider: string;
  validatorDns: string;
}

// =============================================
// ENHANCED PROCESSING INTERFACES
// =============================================

export interface EnhancedLogProcessingResult extends LogProcessingResult {
  blockProposalEvents: BlockProposalEvent[];
  qcParticipationEvents: QCParticipationEvent[];
  separateMetrics: SeparateValidatorMetrics[];
}

export interface SeparateMetricsProcessor {
  processLedgerEvents(logs: RawLog[]): BlockProposalEvent[];
  processBFTEvents(logs: RawLog[]): QCParticipationEvent[];
  extractBlockProposal(logEntry: any): BlockProposalEvent | null;
  extractQCParticipation(logEntry: any, validatorRegistry?: Map<number, string>): QCParticipationEvent[];
  calculateSeparateMetrics(
    blockProposals: BlockProposalEvent[], 
    qcParticipations: QCParticipationEvent[]
  ): SeparateValidatorMetrics[];
}

export interface QCBitVecParser {
  parseBitVec(bitVecString: string): number[];
  extractValidatorParticipation(
    qcData: any, 
    seqNum: number, 
    validatorRegistry?: Map<number, string>
  ): QCParticipationEvent[];
  mapIndexToValidatorId(index: number, epoch?: number): string;
}

// =============================================
// LEDGER EVENT PROCESSING TYPES  
// =============================================

export interface LedgerProposedBlockEvent {
  message: 'proposed_block';
  round: string;
  seq_num: string;
  epoch: string;
  author: string;
  num_tx: string;
  block_id?: string;
  author_address?: string;
}

export interface LedgerFinalizedBlockEvent {
  message: 'finalized_block';
  round: string;
  parent_round: string;
  seq_num: string;
  epoch: string;
  author: string;
  block_ts_ms: string;
  now_ts_ms: string;
  author_address?: string;
}

export interface LedgerTimeoutEvent {
  message: 'timeout';
  round: string;
  author: string;
  epoch?: string;
  author_address?: string;
}

export type LedgerBlockEvent = LedgerProposedBlockEvent | LedgerFinalizedBlockEvent | LedgerTimeoutEvent;

// =============================================
// BFT QC PROCESSING TYPES
// =============================================

export interface BFTQCCommitEvent {
  message: 'try committing blocks using qc';
  qc: string; // Contains QC data with BitVec
  seq_num?: string;
  round: string;
  epoch: string;
}

export interface ParsedQCData {
  signerBits: number[];
  round: number;
  epoch: number;
  seqNum?: number;
  totalValidators: number;
  participatingValidators: number;
  blockId: string;
}

// =============================================
// VALIDATOR REGISTRY INTEGRATION
// =============================================

export interface ValidatorRegistryEntry {
  position: number;
  validatorId: string;
  nodeId: string;
  stake: number;
}

export interface ValidatorMappingService {
  getValidatorByPosition(position: number, epoch?: number): ValidatorRegistryEntry | null;
  getPositionByValidatorId(validatorId: string, epoch?: number): number | null;
  updateEpochMapping(epoch: number, validators: ValidatorRegistryEntry[]): void;
  getCurrentEpochValidators(): ValidatorRegistryEntry[];
}

// =============================================
// BFT CONSENSUS TRACKING TYPES (NEW)
// =============================================

// BFT Vote Message Event ("vote message" logs)
export interface BftVoteEvent {
  timestamp: Date;
  epoch: number;
  round: number;
  author: string; // Validator public key
  sig: string; // BLS signature
  voteId: string; // Vote ID (truncated hash format like "9db8..cabe")
  eventId: string; // SHA1 hash for deduplication
}

// BFT Round State Event ("collecting vote" logs)
export interface BftRoundStateEvent {
  timestamp: Date;
  epoch: number;
  round: number;
  currentStake: bigint; // Current accumulated stake
  totalStake: bigint; // Total possible stake
  stakeRatio: number; // Quorum percentage (0-100)
  eventId: string; // SHA1 hash for deduplication
}

// BFT Vote Message Log Fields
export interface BftVoteMessageFields {
  message: 'vote message';
  author: string;
  vote_msg: string; // Contains Vote and BLS signature
}

// BFT Collecting Vote Log Fields
export interface BftCollectingVoteFields {
  message: 'collecting vote';
  round: string;
  epoch: string;
  vote: string;
  current_stake: string; // Format: "Ok(Stake(1273254265463543980894843884))"
  total_stake: string; // Format: "Stake(9554473084196538460577820321)"
}

// Extended EnhancedLogProcessingResult to include BFT events
export interface BftEnhancedLogProcessingResult extends EnhancedLogProcessingResult {
  bftVoteEvents: BftVoteEvent[];
  bftRoundStates: BftRoundStateEvent[];
} 