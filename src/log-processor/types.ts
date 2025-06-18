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
  totalValidators: number;
  participatingValidators: number;
  participationBitmap: string; // BitVec as string
  participationRate: number;
  validatorParticipation: Array<{
    validatorId: string;
    nodeId: string; // Actual validator address from registry
    participated: boolean;
    position: number;
    stake: number; // Validator stake amount
  }>;
  blsSignature: string;
  signatureVerificationTimeNs?: number;
  qcAssemblyTimeMs: number;
  epoch?: number; // Track which epoch this QC data belongs to
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
  id: string;
  epoch: number;
  round: number;
  parentId?: string; // pid in logs
  parentRound?: number; // pr in logs
}

export interface VoteChain {
  voteId: string;
  round: number;
  epoch: number;
  parentVoteId?: string;
  parentRound?: number;
  nextLeaderId?: string;
  validatorId: string;
  timestamp: Date;
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
  events: ParsedEvent[];
  qcParticipation: QCParticipationData[];
  voteChains: VoteChain[];
  validatorInfrastructure: ValidatorInfrastructure[];
  errors: ProcessingError[];
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
  'committed block': EventType.BLOCK_COMMITTED,
  'skipped_block': EventType.BLOCK_SKIPPED,
  'base seq num committed': EventType.BLOCK_SEQUENCE_COMMITTED,
  'txpool updating committed block': EventType.TXPOOL_UPDATED
};

export const GeographicRegionMapping: Record<string, string> = {
  'sgp': 'Singapore',
  'jfk': 'New York JFK',
  'fra': 'Frankfurt',
  'pit': 'Pittsburgh', 
  'cdg': 'Paris CDG'
};

export const ProviderMapping: Record<string, string> = {
  'mf': 'monadinfra',
  'monadinfra': 'monadinfra',
  'quantnode': 'quantnode',
  'node3tech': 'node3tech',
  'brightlystake': 'brightlystake',
  'go2pro': 'go2pro',
  'liquify': 'liquify'
}; 