// Monad Validator Analytics - Enhanced Log Processor Implementation
// Implements comprehensive log parsing based on Phase 1 analysis findings
// Supports QC participation, vote chains, geographic intelligence

import { v4 as uuidv4 } from 'uuid';
import {
  RawLog,
  ConsensusEvent,
  LedgerEvent,
  ParsedEvent,
  EventType,
  EventTypeMapping,
  QCParticipationData,
  VoteChain,
  VoteInfo,
  ValidatorInfrastructure,
  LogProcessingResult,
  ProcessingError,
  ProcessingConfig,
  EnhancedLogProcessor,
  QCParticipationParser,
  VoteChainBuilder,
  GeographicRegionMapping,
  ProviderMapping
} from './types';

// Import new enhanced DNS utilities
import { 
  EnhancedDNSProcessor,
  createEnhancedDNSProcessor,
  DNSParseResult as NewDNSParseResult,
  LocationInfo
} from '../utils';

export class MonadLogProcessor implements EnhancedLogProcessor {
  private qcParser: QCParticipationParserImpl;
  private dnsParser: DNSIntelligenceParserImpl;
  private voteChainBuilder: VoteChainBuilderImpl;
  private config: ProcessingConfig;
  private validatorRegistry: Map<string, ValidatorInfrastructure> = new Map();

  constructor(config: ProcessingConfig) {
    this.config = config;
    this.qcParser = new QCParticipationParserImpl();
    this.dnsParser = new DNSIntelligenceParserImpl();
    this.voteChainBuilder = new VoteChainBuilderImpl();
  }

  // =============================================
  // MAIN PROCESSING ENTRY POINT
  // =============================================

  async processBatch(logs: RawLog[]): Promise<LogProcessingResult> {
    const startTime = Date.now();
    const ingestionId = uuidv4();
    
    const result: LogProcessingResult = {
      events: [],
      qcParticipation: [],
      voteChains: [],
      validatorInfrastructure: [],
      errors: []
    };

    try {
      // Process in parallel for performance
      const consensusLogs = logs.filter(log => log.target === 'monad_consensus_state');
      const ledgerLogs = logs.filter(log => log.target === 'ledger_tail');
      
      // Parse consensus events
      const consensusEvents = this.parseConsensusEvents(consensusLogs);
      result.events.push(...consensusEvents);
      
      // Parse ledger events
      const ledgerEvents = this.parseLedgerEvents(ledgerLogs);
      result.events.push(...ledgerEvents);
      
      // Extract QC participation data if enabled
      if (this.config.enableQCParsing) {
        result.qcParticipation = await this.extractQCParticipationBatch(consensusLogs);
      }
      
      // Build vote chains if enabled
      if (this.config.enableVoteChainAnalysis) {
        const voteEvents = this.extractVoteEvents(consensusEvents);
        result.voteChains = this.buildVoteChain(voteEvents);
      }
      
      // Extract validator infrastructure
      if (this.config.enableGeographicIntelligence) {
        result.validatorInfrastructure = this.extractValidatorInfrastructure(result.events);
      }

    } catch (error) {
      result.errors.push({
        logContent: JSON.stringify(logs.slice(0, 3)), // Sample for debugging
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
        ingestionId
      });
    }

    return result;
  }

  // =============================================
  // CONSENSUS EVENT PARSING
  // =============================================

  parseConsensusEvents(logs: RawLog[]): ConsensusEvent[] {
    const events: ConsensusEvent[] = [];
    
    for (const log of logs) {
      try {
        const event = this.parseConsensusEvent(log);
        if (event) {
          events.push(event);
        }
      } catch (error) {
        // Log parsing error but continue processing
        console.warn(`Failed to parse consensus event: ${error}`);
      }
    }
    
    return events;
  }

  private parseConsensusEvent(log: RawLog): ConsensusEvent | null {
    const fields = log.fields;
    const message = fields.message;
    
    if (!message || !EventTypeMapping[message]) {
      return null;
    }

    const timestamp = new Date(log.timestamp);
    const eventType = EventTypeMapping[message];
    const ingestionId = uuidv4();

    // Extract basic fields
    const baseEvent = {
      timestamp,
      eventType,
      validatorId: this.extractValidatorId(fields, log.target),
      roundNumber: parseInt(fields.round) || 0,
      epochNumber: parseInt(fields.epoch) || 1,
      blockNumber: fields.block_num ? parseInt(fields.block_num) : undefined,
      blockId: fields.block_id,
      processingTimestampMs: timestamp.getTime(),
      processingDelayMs: this.calculateProcessingDelay(timestamp),
      transactionCount: parseInt(fields.num_tx) || 0,
      isSuccessful: this.determineSuccess(fields, eventType),
      metadata: JSON.stringify(fields),
      ingestionId
    };

    // Extract event-specific data
    const enhancedEvent = this.enhanceConsensusEvent(baseEvent, fields, eventType);
    
    return enhancedEvent;
  }

  private enhanceConsensusEvent(baseEvent: any, fields: any, eventType: EventType): ConsensusEvent {
    const enhanced = { ...baseEvent };

    // Extract vote chain relationships
    if (fields.vote) {
      const voteInfo = this.voteChainBuilder.extractVoteInfo(fields.vote);
      enhanced.parentVoteId = voteInfo.parentId;
      enhanced.parentRound = voteInfo.parentRound;
    }

    // Extract next leader information
    if (fields.next_leader) {
      enhanced.nextLeaderId = fields.next_leader;
    }

    // Extract state root action
    if (fields.state_root_action) {
      enhanced.stateRootAction = fields.state_root_action;
    }

    // Extract sequence number
    if (fields.seqnum) {
      enhanced.sequenceNumber = parseInt(fields.seqnum);
    }

    // Extract timing data
    if (fields.block_ts_ms) {
      enhanced.blockTimestampMs = parseInt(fields.block_ts_ms);
    }

    // Extract QC participation data for specific events
    if (eventType === EventType.QC_COMMIT_TRIGGERED && fields.qc) {
      try {
        const qcData = this.qcParser.extractParticipation(fields.qc);
        enhanced.participantCount = qcData.participatingValidators;
        enhanced.participationRate = qcData.participationRate;
      } catch (error) {
        console.warn(`Failed to parse QC data: ${error}`);
      }
    }

    // Add infrastructure intelligence
    const validatorDns = this.extractValidatorDns(fields);
    if (validatorDns) {
      enhanced.validatorDns = validatorDns;
      const dnsInfo = this.dnsParser.parseDNS(validatorDns);
      enhanced.geographicRegion = this.dnsParser.extractGeographicRegion(validatorDns);
      enhanced.infrastructureProvider = this.dnsParser.extractInfrastructureProvider(validatorDns);
      enhanced.datacenterCode = this.dnsParser.extractDatacenterCode(validatorDns);
    } else {
      enhanced.validatorDns = '';
      enhanced.geographicRegion = 'unknown';
      enhanced.infrastructureProvider = 'unknown';
      enhanced.datacenterCode = 'unknown';
    }

    return enhanced as ConsensusEvent;
  }

  // =============================================
  // LEDGER EVENT PARSING
  // =============================================

  parseLedgerEvents(logs: RawLog[]): LedgerEvent[] {
    const events: LedgerEvent[] = [];
    
    for (const log of logs) {
      try {
        const event = this.parseLedgerEvent(log);
        if (event) {
          events.push(event);
        }
      } catch (error) {
        console.warn(`Failed to parse ledger event: ${error}`);
      }
    }
    
    return events;
  }

  private parseLedgerEvent(log: RawLog): LedgerEvent | null {
    const fields = log.fields;
    const message = fields.message;
    
    if (!message || !EventTypeMapping[message]) {
      return null;
    }

    const timestamp = new Date(log.timestamp);
    const eventType = EventTypeMapping[message];
    const ingestionId = uuidv4();

    // Extract validator information from author field
    const validatorId = fields.author || '';
    const validatorDns = fields.author_dns || '';

    // Parse timing information
    const blockTimestampMs = parseInt(fields.block_ts_ms) || timestamp.getTime();
    const processingTimestampMs = parseInt(fields.now_ts_ms) || timestamp.getTime();
    const processingDelayMs = processingTimestampMs - blockTimestampMs;

    // Build ledger event
    const event: LedgerEvent = {
      timestamp,
      eventType,
      validatorId,
      roundNumber: parseInt(fields.round) || 0,
      epochNumber: parseInt(fields.epoch) || 1,
      blockNumber: fields.seq_num ? parseInt(fields.seq_num) : undefined,
      parentRound: fields.parent_round ? parseInt(fields.parent_round) : undefined,
      sequenceNumber: fields.seq_num ? parseInt(fields.seq_num) : undefined,
      transactionCount: parseInt(fields.num_tx) || 0,
      blockTimestampMs,
      processingTimestampMs,
      processingDelayMs: Math.max(0, processingDelayMs),
      validatorDns,
      geographicRegion: this.dnsParser.extractGeographicRegion(validatorDns),
      infrastructureProvider: this.dnsParser.extractInfrastructureProvider(validatorDns),
      datacenterCode: this.dnsParser.extractDatacenterCode(validatorDns),
      ingestionId
    };

    return event;
  }

  // =============================================
  // QC PARTICIPATION EXTRACTION
  // =============================================

  extractQCParticipation(qcData: string): QCParticipationData {
    return this.qcParser.extractParticipation(qcData);
  }

  private async extractQCParticipationBatch(logs: RawLog[]): Promise<QCParticipationData[]> {
    const qcData: QCParticipationData[] = [];
    
    for (const log of logs) {
      try {
        if (log.fields.qc && log.fields.message === 'qc triggered commit') {
          const participation = this.qcParser.extractParticipation(log.fields.qc);
          qcData.push(participation);
        }
      } catch (error) {
        console.warn(`Failed to extract QC participation: ${error}`);
      }
    }
    
    return qcData;
  }

  // =============================================
  // VALIDATOR INFRASTRUCTURE PARSING
  // =============================================

  parseValidatorInfrastructure(dns: string): ValidatorInfrastructure {
    const dnsInfo = this.dnsParser.parseDNS(dns);
    
    return {
      validatorId: '', // Will be populated by caller
      dnsName: dns,
      geographicRegion: this.dnsParser.extractGeographicRegion(dns),
      infrastructureProvider: this.dnsParser.extractInfrastructureProvider(dns),
      datacenterCode: this.dnsParser.extractDatacenterCode(dns),
      providerType: this.dnsParser.classifyProviderType(dnsInfo.provider),
      endpointHost: dnsInfo.domain,
      endpointPort: dnsInfo.port
    };
  }

  private extractValidatorInfrastructure(events: ParsedEvent[]): ValidatorInfrastructure[] {
    const infrastructureMap = new Map<string, ValidatorInfrastructure>();
    
    for (const event of events) {
      if (event.validatorId && event.validatorDns && !infrastructureMap.has(event.validatorId)) {
        const infrastructure = this.parseValidatorInfrastructure(event.validatorDns);
        infrastructure.validatorId = event.validatorId;
        infrastructureMap.set(event.validatorId, infrastructure);
      }
    }
    
    return Array.from(infrastructureMap.values());
  }

  // =============================================
  // VOTE CHAIN BUILDING
  // =============================================

  buildVoteChain(voteEvents: VoteInfo[]): VoteChain[] {
    return this.voteChainBuilder.buildChain(voteEvents);
  }

  private extractVoteEvents(events: ConsensusEvent[]): VoteInfo[] {
    const voteEvents: VoteInfo[] = [];
    
    for (const event of events) {
      if (event.eventType === EventType.VOTE_RESULT && event.metadata) {
        try {
          const fields = JSON.parse(event.metadata);
          if (fields.vote) {
            const voteInfo = this.voteChainBuilder.extractVoteInfo(fields.vote);
            voteEvents.push(voteInfo);
          }
        } catch (error) {
          console.warn(`Failed to extract vote info: ${error}`);
        }
      }
    }
    
    return voteEvents;
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  private extractValidatorId(fields: any, target: string): string {
    // Try to extract validator ID from various fields
    if (fields.author) return fields.author;
    if (fields.validator_id) return fields.validator_id;
    if (fields.pid) return fields.pid;
    
    // For consensus events, try to extract from proposal
    if (target === 'monad_consensus_state' && fields.proposal) {
      const authorMatch = fields.proposal.match(/author: ([a-f0-9]{64})/);
      if (authorMatch) return authorMatch[1];
    }
    
    return 'unknown';
  }

  private extractValidatorDns(fields: any): string {
    return fields.author_dns || fields.validator_dns || '';
  }

  private calculateProcessingDelay(timestamp: Date): number {
    return Date.now() - timestamp.getTime();
  }

  private determineSuccess(fields: any, eventType: EventType): boolean {
    // Determine success based on event type and field content
    switch (eventType) {
      case EventType.VOTE_RESULT:
        return fields.vote && fields.vote.includes('Some(');
      case EventType.QC_COMMIT_TRIGGERED:
        return fields.num_commits && parseInt(fields.num_commits) > 0;
      case EventType.BLOCK_COMMITTED:
        return true; // If the event exists, it was successful
      default:
        return true;
    }
  }
}

// =============================================
// QC PARTICIPATION PARSER IMPLEMENTATION
// =============================================

class QCParticipationParserImpl implements QCParticipationParser {
  parseBitVec(bitVecString: string): number[] {
    // Extract BitVec array from string like "[0, 1, 1, 0, 0, 1, 1, 0, ...]"
    const match = bitVecString.match(/\[([0-9, ]+)\]/);
    if (!match) return [];
    
    return match[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  }

  extractParticipation(qcString: string): QCParticipationData {
    try {
      // Parse QC string to extract participation data
      const bitsMatch = qcString.match(/bits: (\d+)/);
      const totalValidators = bitsMatch ? parseInt(bitsMatch[1]) : 169;
      
      // Extract BitVec
      const bitmap = this.parseBitVec(qcString);
      const participatingValidators = bitmap.filter(bit => bit === 1).length;
      const participationRate = this.calculateParticipationRate(participatingValidators, totalValidators);
      
      // Extract BLS signature
      const sigMatch = qcString.match(/BlsAggregateSignature\("([^"]+)"\)/);
      const blsSignature = sigMatch ? sigMatch[1] : '';
      
      return {
        totalValidators,
        participatingValidators,
        participationBitmap: bitmap.join(''),
        participationRate,
        validatorParticipation: this.mapValidatorPositions(bitmap, []), // Validator IDs would need separate mapping
        blsSignature,
        qcAssemblyTimeMs: 0 // Would need timing data from logs
      };
    } catch (error) {
      throw new Error(`Failed to parse QC participation: ${error}`);
    }
  }

  calculateParticipationRate(participating: number, total: number): number {
    return total > 0 ? participating / total : 0;
  }

  mapValidatorPositions(bitmap: number[], validatorIds: string[]): Array<{
    validatorId: string;
    participated: boolean;
    position: number;
  }> {
    return bitmap.map((bit, index) => ({
      validatorId: validatorIds[index] || `validator_${index}`,
      participated: bit === 1,
      position: index
    }));
  }
}

// =============================================
// DNS INTELLIGENCE PARSER IMPLEMENTATION
// =============================================

class DNSIntelligenceParserImpl implements DNSIntelligenceParser {
  parseDNS(dnsString: string): DNSParseResult {
    // Parse DNS like "mf-testnet-2-val-tsw-sgp-004.monadinfra.com:8000"
    const parts = dnsString.split(':');
    const hostPart = parts[0];
    const port = parts[1] ? parseInt(parts[1]) : 8000;
    
    const hostParts = hostPart.split('.');
    const subdomain = hostParts[0];
    const domain = hostParts.slice(1).join('.');
    
    const subdomainParts = subdomain.split('-');
    
    return {
      provider: subdomainParts[0] || 'unknown',
      network: subdomainParts.slice(1, 3).join('-') || 'unknown',
      tier: subdomainParts[3] || 'unknown',
      type: subdomainParts[4] || 'unknown',
      region: subdomainParts[6] || 'unknown',
      location: subdomainParts.slice(5).join('-') || 'unknown',
      instance: subdomainParts[subdomainParts.length - 1] || 'unknown',
      domain,
      port
    };
  }

  extractGeographicRegion(dns: string): string {
    const dnsInfo = this.parseDNS(dns);
    return GeographicRegionMapping[dnsInfo.region] || dnsInfo.region || 'unknown';
  }

  extractInfrastructureProvider(dns: string): string {
    const dnsInfo = this.parseDNS(dns);
    return ProviderMapping[dnsInfo.provider] || dnsInfo.domain.split('.')[0] || 'unknown';
  }

  extractDatacenterCode(dns: string): string {
    const dnsInfo = this.parseDNS(dns);
    return dnsInfo.location || 'unknown';
  }

  classifyProviderType(provider: string): 'monadinfra' | 'community' | 'enterprise' {
    if (provider.includes('monadinfra') || provider === 'mf') {
      return 'monadinfra';
    } else if (['brightlystake', 'liquify', 'node3tech'].includes(provider)) {
      return 'enterprise';
    } else {
      return 'community';
    }
  }
}

// =============================================
// VOTE CHAIN BUILDER IMPLEMENTATION
// =============================================

class VoteChainBuilderImpl implements VoteChainBuilder {
  extractVoteInfo(voteString: string): VoteInfo {
    // Parse vote string like "Vote { id: aee1..7277, epoch: 1, r: 29573, pid: e7ec..6dd2, pr: 29572 }"
    const idMatch = voteString.match(/id: ([a-f0-9.]+)/);
    const epochMatch = voteString.match(/epoch: (\d+)/);
    const roundMatch = voteString.match(/r: (\d+)/);
    const pidMatch = voteString.match(/pid: ([a-f0-9.]+)/);
    const prMatch = voteString.match(/pr: (\d+)/);
    
    return {
      id: idMatch ? idMatch[1] : '',
      epoch: epochMatch ? parseInt(epochMatch[1]) : 0,
      round: roundMatch ? parseInt(roundMatch[1]) : 0,
      parentId: pidMatch ? pidMatch[1] : undefined,
      parentRound: prMatch ? parseInt(prMatch[1]) : undefined
    };
  }

  buildChain(votes: VoteInfo[]): VoteChain[] {
    const chains: VoteChain[] = [];
    
    // Sort votes by round for proper chain building
    const sortedVotes = votes.sort((a, b) => a.round - b.round);
    
    for (const vote of sortedVotes) {
      const chain: VoteChain = {
        voteId: vote.id,
        round: vote.round,
        epoch: vote.epoch,
        parentVoteId: vote.parentId,
        parentRound: vote.parentRound,
        validatorId: '', // Would need additional context
        timestamp: new Date() // Would need actual timestamp
      };
      
      chains.push(chain);
    }
    
    return chains;
  }

  findParentVote(vote: VoteInfo, previousVotes: VoteInfo[]): VoteInfo | null {
    if (!vote.parentId) return null;
    
    return previousVotes.find(v => v.id === vote.parentId) || null;
  }

  validateChainIntegrity(chain: VoteChain[]): boolean {
    // Validate that rounds are sequential and parent relationships are correct
    for (let i = 1; i < chain.length; i++) {
      const current = chain[i];
      const previous = chain[i - 1];
      
      if (current.parentRound !== previous.round) {
        return false;
      }
    }
    
    return true;
  }
} 