// Monad Validator Analytics - Enhanced Log Processor V2
// Updated to use the new intelligent DNS utilities

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
  ProcessingConfig,
  QCParticipationParser,
  VoteChainBuilder
} from './types';

// Import new enhanced DNS utilities
import { 
  EnhancedDNSProcessor,
  createEnhancedDNSProcessor,
  NetworkDiscoveryResult
} from '../utils';

// Import validator registry for mapping bitvec positions to actual validators
import { validatorRegistry, ValidatorRegistry } from '../services/validator-registry';
import { ValidatorDNSMapperService } from '../services/validator-dns-mapper';

export class MonadLogProcessor {
  private qcParser: QCParticipationParserImpl;
  private enhancedDnsProcessor: EnhancedDNSProcessor;
  private voteChainBuilder: VoteChainBuilderImpl;
  private config: ProcessingConfig;
  private validatorRegistry: ValidatorRegistry;
  private dnsMapper: ValidatorDNSMapperService;
  private isRegistryInitialized: boolean = false;

  constructor(config: ProcessingConfig) {
    this.config = config;
    this.validatorRegistry = validatorRegistry;
    this.qcParser = new QCParticipationParserImpl(this.validatorRegistry);
    this.enhancedDnsProcessor = createEnhancedDNSProcessor();
    this.voteChainBuilder = new VoteChainBuilderImpl();
    this.dnsMapper = new ValidatorDNSMapperService(this.validatorRegistry);
  }

  async initialize(): Promise<void> {
    if (!this.isRegistryInitialized) {
      await this.validatorRegistry.initialize();
      await this.dnsMapper.initialize();
      this.isRegistryInitialized = true;
      console.log('✅ Enhanced processor initialized with DNS optimization');
    }
  }

  private detectEpochFromLogs(logs: RawLog[]): number {
    // Try to detect epoch from log fields first
    for (const log of logs) {
      if (log.fields.epoch && !isNaN(parseInt(log.fields.epoch))) {
        return parseInt(log.fields.epoch);
      }
    }

    // Try to detect epoch from validator IDs
    for (const log of logs) {
      const validatorId = this.extractValidatorId(log.fields, log.target);
      if (validatorId && validatorId !== 'unknown') {
        const detectedEpoch = this.validatorRegistry.detectEpochFromLogs(validatorId);
        if (detectedEpoch) {
          console.log(`Detected epoch ${detectedEpoch} from validator ${validatorId}`);
          return detectedEpoch;
        }
      }
    }

    // Default to epoch 1 if no detection possible
    console.warn('Could not detect epoch from logs, defaulting to epoch 1');
    return 1;
  }

  // =============================================
  // MAIN PROCESSING ENTRY POINT (Enhanced)
  // =============================================

  async processBatch(logs: RawLog[]): Promise<LogProcessingResult> {
    const ingestionId = uuidv4();
    
    const result: LogProcessingResult = {
      events: [],
      qcParticipation: [],
      voteChains: [],
      validatorInfrastructure: [],
      errors: []
    };

    try {
      const detectedEpoch = this.detectEpochFromLogs(logs);
      this.validatorRegistry.setCurrentEpoch(detectedEpoch);
      
      const consensusLogs = logs.filter(log => log.target === 'monad_consensus_state');
      const ledgerLogs = logs.filter(log => log.target === 'ledger_tail');
      
      // Parse consensus events with enhanced DNS processing
      const consensusEvents = await this.parseConsensusEventsAsync(consensusLogs);
      result.events.push(...consensusEvents);
      
      // Parse ledger events with enhanced DNS processing
      const ledgerEvents = await this.parseLedgerEventsAsync(ledgerLogs);
      result.events.push(...ledgerEvents);
      
      // Extract QC participation data
      if (this.config.enableQCParsing) {
        result.qcParticipation = await this.extractQCParticipationBatch(consensusLogs);
      }
      
      // Build vote chains
      if (this.config.enableVoteChainAnalysis) {
        const voteEvents = this.extractVoteEvents(consensusEvents);
        result.voteChains = this.buildVoteChain(voteEvents);
      }
      
      // Extract validator infrastructure using enhanced DNS processor
      if (this.config.enableGeographicIntelligence) {
        result.validatorInfrastructure = await this.extractValidatorInfrastructureEnhanced(result.events);
      }

    } catch (error) {
      result.errors.push({
        logContent: JSON.stringify(logs.slice(0, 3)),
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
        ingestionId
      });
    }

    return result;
  }

  // =============================================
  // CONSENSUS EVENT PARSING (Enhanced)
  // =============================================

  async parseConsensusEventsAsync(logs: RawLog[]): Promise<ConsensusEvent[]> {
    const events: ConsensusEvent[] = [];
    
    for (const log of logs) {
      try {
        const event = await this.parseConsensusEventAsync(log);
        if (event) {
          events.push(event);
        }
      } catch (error) {
        console.warn(`Failed to parse consensus event: ${error}`);
      }
    }
    
    return events;
  }

  private async parseConsensusEventAsync(log: RawLog): Promise<ConsensusEvent | null> {
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

    // Extract event-specific data with enhanced DNS processing
    const enhancedEvent = await this.enhanceConsensusEventV2(baseEvent, fields, eventType);
    
    return enhancedEvent;
  }

  private async enhanceConsensusEventV2(baseEvent: any, fields: any, eventType: EventType): Promise<ConsensusEvent> {
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
        const epoch = enhanced.epochNumber || 1;
        const qcData = this.qcParser.extractParticipation(fields.qc, epoch);
        enhanced.participantCount = qcData.participatingValidators;
        enhanced.participationRate = qcData.participationRate;
      } catch (error) {
        console.warn(`Failed to parse QC data: ${error}`);
      }
    }

    // Add enhanced infrastructure intelligence
    const validatorDns = this.extractValidatorDns(fields);
    if (validatorDns) {
      try {
        const dnsInfo = await this.enhancedDnsProcessor.processValidatorDNS(validatorDns, enhanced.validatorId);
        enhanced.validatorDns = validatorDns;
        enhanced.geographicRegion = `${dnsInfo.locationInfo.city}, ${dnsInfo.locationInfo.country}`;
        enhanced.infrastructureProvider = dnsInfo.provider;
        enhanced.datacenterCode = dnsInfo.locationInfo.datacenter;
      } catch (error) {
        console.warn(`Failed to process DNS for ${validatorDns}:`, error);
        enhanced.validatorDns = validatorDns;
        enhanced.geographicRegion = 'unknown';
        enhanced.infrastructureProvider = this.extractProviderFromDomain(validatorDns);
        enhanced.datacenterCode = 'unknown';
      }
    } else {
      enhanced.validatorDns = '';
      enhanced.geographicRegion = 'unknown';
      enhanced.infrastructureProvider = 'unknown';
      enhanced.datacenterCode = 'unknown';
    }

    return enhanced;
  }

  // =============================================
  // LEDGER EVENT PARSING (Enhanced)
  // =============================================

  async parseLedgerEventsAsync(logs: RawLog[]): Promise<LedgerEvent[]> {
    const events: LedgerEvent[] = [];
    
    // Extract unique DNS addresses to process
    const uniqueDNSValidators = this.dnsMapper.extractUniqueDNSFromLogs(logs);
    
    // Process unique DNS addresses in batch if any new ones found
    if (uniqueDNSValidators.length > 0) {
      const processed = await this.dnsMapper.batchProcessValidatorDNS(uniqueDNSValidators);
      console.log(`Successfully processed ${processed.length}/${uniqueDNSValidators.length} new validator DNS addresses`);
    }

    // Process logs with cached DNS info
    for (const log of logs) {
      try {
        const event = await this.parseLedgerEventAsync(log);
        if (event) {
          events.push(event);
        }
      } catch (error) {
        console.warn('Failed to parse ledger event:', error);
      }
    }

    return events;
  }

  private async parseLedgerEventAsync(log: RawLog): Promise<LedgerEvent | null> {
    const fields = log.fields;
    const message = fields.message;
    
    if (!message || !EventTypeMapping[message]) {
      return null;
    }

    const timestamp = new Date(log.timestamp);
    const eventType = EventTypeMapping[message];
    const ingestionId = uuidv4();
    const validatorDns = this.extractValidatorDns(fields);

    let geographicRegion = 'unknown';
    let infrastructureProvider = 'unknown';
    let datacenterCode = 'unknown';

    if (validatorDns) {
      // Use cached DNS information instead of processing each event individually
      const validatorId = this.extractValidatorId(fields, log.target);
      const cachedDnsInfo = await this.dnsMapper.getValidatorDNS(validatorId, validatorDns);
      
      if (cachedDnsInfo) {
        geographicRegion = cachedDnsInfo.location || 'unknown';
        infrastructureProvider = cachedDnsInfo.provider || 'unknown';
        datacenterCode = 'unknown'; // Will be enhanced later
      } else {
        // Fallback to domain-based provider extraction without external API calls
        infrastructureProvider = this.extractProviderFromDomain(validatorDns);
      }
    }

    return {
      timestamp,
      eventType,
      validatorId: this.extractValidatorId(fields, log.target),
      roundNumber: parseInt(fields.round) || 0,
      epochNumber: parseInt(fields.epoch) || 1,
      blockNumber: fields.block_num ? parseInt(fields.block_num) : undefined,
      parentRound: parseInt(fields.parent_round) || undefined,
      sequenceNumber: parseInt(fields.seqnum) || undefined,
      transactionCount: parseInt(fields.num_tx) || 0,
      blockTimestampMs: parseInt(fields.block_ts_ms) || timestamp.getTime(),
      processingTimestampMs: timestamp.getTime(),
      processingDelayMs: this.calculateProcessingDelay(timestamp),
      validatorDns,
      geographicRegion,
      infrastructureProvider,
      datacenterCode,
      ingestionId
    };
  }

  // =============================================
  // ENHANCED VALIDATOR INFRASTRUCTURE EXTRACTION
  // =============================================

  private async extractValidatorInfrastructureEnhanced(events: ParsedEvent[]): Promise<ValidatorInfrastructure[]> {
    const validators = new Map<string, { validatorId: string; dnsAddress: string }>();
    
    events.forEach(event => {
      if (event.validatorId && 'validatorDns' in event && event.validatorDns) {
        validators.set(event.validatorId, {
          validatorId: event.validatorId,
          dnsAddress: event.validatorDns
        });
      }
    });

    const validatorArray = Array.from(validators.values());
    const results = await this.enhancedDnsProcessor.processBatchValidatorDNS(validatorArray);
    
    const infrastructure: ValidatorInfrastructure[] = [];
    
    for (let i = 0; i < validatorArray.length && i < results.length; i++) {
      const validator = validatorArray[i];
      const dnsResult = results[i];
      
      infrastructure.push({
        validatorId: validator.validatorId,
        dnsName: dnsResult.hostname,
        geographicRegion: `${dnsResult.locationInfo.city}, ${dnsResult.locationInfo.country}`,
        infrastructureProvider: dnsResult.provider,
        datacenterCode: dnsResult.locationInfo.datacenter,
        providerType: this.classifyProviderType(dnsResult.provider),
        endpointHost: dnsResult.hostname,
        endpointPort: dnsResult.port
      });
    }

    return infrastructure;
  }

  // =============================================
  // ENHANCED ANALYTICS METHODS
  // =============================================

  async getNetworkTopology(): Promise<NetworkDiscoveryResult | null> {
    try {
      return await this.enhancedDnsProcessor.analyzeNetworkTopology();
    } catch (error) {
      console.error('Failed to get network topology:', error);
      return null;
    }
  }

  async getCentralizationRisks(): Promise<{
    providerRisk: number;
    geographicRisk: number;
    datacenterRisk: number;
    overallRisk: 'low' | 'medium' | 'high';
    riskFactors: string[];
  } | null> {
    try {
      return await this.enhancedDnsProcessor.getCentralizationRisks();
    } catch (error) {
      console.error('Failed to get centralization risks:', error);
      return null;
    }
  }

  getDNSCacheStats(): {
    totalEntries: number;
    validEntries: number;
    expiredEntries: number;
    hitRate: number;
    memoryUsage: number;
  } {
    return this.enhancedDnsProcessor.getCacheStats();
  }

  parseValidatorInfrastructure(dns: string): ValidatorInfrastructure {
    const hostname = dns.split(':')[0];
    const port = dns.includes(':') ? parseInt(dns.split(':')[1]) : 8000;
    const provider = this.extractProviderFromDomain(dns);
    
    return {
      validatorId: 'unknown',
      dnsName: hostname,
      geographicRegion: 'unknown',
      infrastructureProvider: provider,
      datacenterCode: 'unknown',
      providerType: this.classifyProviderType(provider),
      endpointHost: hostname,
      endpointPort: port
    };
  }

  buildVoteChain(voteEvents: VoteInfo[]): VoteChain[] {
    return this.voteChainBuilder.buildChain(voteEvents);
  }

  // =============================================
  // HELPER METHODS
  // =============================================

  private async extractQCParticipationBatch(logs: RawLog[]): Promise<QCParticipationData[]> {
    const qcData: QCParticipationData[] = [];
    
    for (const log of logs) {
      try {
        const fields = log.fields;
        if (fields.qc && fields.message === 'QC_COMMIT_TRIGGERED') {
          const epoch = parseInt(fields.epoch) || 1;
          const participation = this.qcParser.extractParticipation(fields.qc, epoch);
          qcData.push(participation);
        }
      } catch (error) {
        console.warn(`Failed to extract QC participation: ${error}`);
      }
    }
    
    return qcData;
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

  private extractValidatorId(fields: any, target: string): string {
    if (fields.author) return fields.author;
    if (fields.validator_id) return fields.validator_id;
    if (fields.pid) return fields.pid;
    
    if (target === 'monad_consensus_state' && fields.proposal) {
      const authorMatch = fields.proposal.match(/author: ([a-f0-9]{64})/);
      if (authorMatch) return authorMatch[1];
    }
    
    return 'unknown';
  }

  private extractValidatorDns(fields: any): string {
    return fields.author_dns || fields.validator_dns || '';
  }

  private extractProviderFromDomain(dns: string): string {
    const hostname = dns.split(':')[0];
    const parts = hostname.split('.');
    
    if (hostname.includes('monadinfra.com')) {
      return 'monadinfra';
    }
    
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    
    return 'unknown';
  }

  private classifyProviderType(provider: string): 'monadinfra' | 'community' | 'enterprise' {
    if (provider.includes('monadinfra') || provider === 'mf') {
      return 'monadinfra';
    } else if (['brightlystake', 'liquify', 'node3tech', 'stakecraft', 'everstake'].includes(provider)) {
      return 'enterprise';
    } else {
      return 'community';
    }
  }

  private calculateProcessingDelay(timestamp: Date): number {
    return Date.now() - timestamp.getTime();
  }

  private determineSuccess(fields: any, eventType: EventType): boolean {
    switch (eventType) {
      case EventType.VOTE_RESULT:
        return fields.vote && fields.vote.includes('Some(');
      case EventType.QC_COMMIT_TRIGGERED:
        return fields.num_commits && parseInt(fields.num_commits) > 0;
      case EventType.BLOCK_COMMITTED:
        return true;
      default:
        return true;
    }
  }

  destroy(): void {
    this.enhancedDnsProcessor.destroy();
  }
}

// =============================================
// EXISTING PARSER IMPLEMENTATIONS
// =============================================

class QCParticipationParserImpl implements QCParticipationParser {
  constructor(private validatorRegistry: ValidatorRegistry) {}

  parseBitVec(bitVecString: string): number[] {
    const match = bitVecString.match(/\[([0-9, ]+)\]/);
    if (!match) return [];
    
    return match[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  }

  extractParticipation(qcString: string, epoch?: number): QCParticipationData {
    try {
      const bitsMatch = qcString.match(/bits: (\d+)/);
      const totalValidators = bitsMatch ? parseInt(bitsMatch[1]) : 169;
      
      const bitmap = this.parseBitVec(qcString);
      const participatingValidators = bitmap.filter(bit => bit === 1).length;
      const participationRate = this.calculateParticipationRate(participatingValidators, totalValidators);
      
      const sigMatch = qcString.match(/BlsAggregateSignature\("([^"]+)"\)/);
      const blsSignature = sigMatch ? sigMatch[1] : '';
      
      return {
        totalValidators,
        participatingValidators,
        participationBitmap: bitmap.join(''),
        participationRate,
        validatorParticipation: this.mapValidatorPositions(bitmap, epoch),
        blsSignature,
        qcAssemblyTimeMs: 0,
        epoch
      };
    } catch (error) {
      throw new Error(`Failed to parse QC participation: ${error}`);
    }
  }

  calculateParticipationRate(participating: number, total: number): number {
    return total > 0 ? participating / total : 0;
  }

  mapValidatorPositions(bitmap: number[], epoch?: number): Array<{
    validatorId: string;
    nodeId: string;
    participated: boolean;
    position: number;
    stake: number;
  }> {
    return this.validatorRegistry.mapBitVecToValidators(bitmap, epoch);
  }
}

class VoteChainBuilderImpl implements VoteChainBuilder {
  extractVoteInfo(voteString: string): VoteInfo {
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
    const sortedVotes = votes.sort((a, b) => a.round - b.round);
    
    for (const vote of sortedVotes) {
      const chain: VoteChain = {
        voteId: vote.id,
        round: vote.round,
        epoch: vote.epoch,
        parentVoteId: vote.parentId,
        parentRound: vote.parentRound,
        validatorId: '',
        timestamp: new Date()
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
