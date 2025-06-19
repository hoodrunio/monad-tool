// Monad Validator Analytics - Enhanced Log Processor V3
// Updated to use new separated validator services with single responsibility

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
  ProcessingConfig
} from './types';

// Import new separated services
import { ValidatorInfoService, CompleteValidatorInfo } from '../services/validator-info-service';

export class MonadLogProcessor {
  private qcParser: QCParticipationParserImpl;
  private voteChainBuilder: VoteChainBuilderImpl;
  private config: ProcessingConfig;
  private validatorInfoService: ValidatorInfoService;
  private isInitialized: boolean = false;

  constructor(config: ProcessingConfig) {
    this.config = config;
    this.validatorInfoService = new ValidatorInfoService();
    this.qcParser = new QCParticipationParserImpl(this.validatorInfoService);
    this.voteChainBuilder = new VoteChainBuilderImpl();
  }

  async initialize(): Promise<void> {
    if (!this.isInitialized) {
      console.log('🔧 Initializing Enhanced Log Processor V3...');
      
      await this.validatorInfoService.initialize();
      
      // Pre-process all validator DNS information for optimal performance
      if (this.config.preProcessDNS !== false) {
        await this.validatorInfoService.preProcessAll();
      }
      
      this.isInitialized = true;
      console.log('✅ Enhanced processor V3 initialized with pre-cached validator information');
    }
  }

  async processLogBatch(logs: RawLog[]): Promise<LogProcessingResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const startTime = Date.now();
    const consensusEvents: ConsensusEvent[] = [];
    const ledgerEvents: LedgerEvent[] = [];
    const qcParticipationData: QCParticipationData[] = [];
    const voteChains: VoteChain[] = [];
    const errors: string[] = [];

    console.log(`📋 Processing batch of ${logs.length} logs...`);

    // Extract unique validator IDs for batch processing
    const validatorIds = new Set<string>();
    logs.forEach(log => {
      const validatorId = this.extractValidatorId(log.fields, log.target);
      if (validatorId && validatorId !== 'unknown') {
        validatorIds.add(validatorId);
      }
    });

    // Pre-fetch validator information for this batch
    const validatorInfoMap = await this.validatorInfoService.batchGetValidatorInfo(
      Array.from(validatorIds)
    );

    // Process each log with pre-cached validator information
    for (let i = 0; i < logs.length; i++) {
      try {
        const log = logs[i];
        const fields = log.fields;
        
        if (!fields || !fields.message) {
          continue;
        }

        const eventType = EventTypeMapping[fields.message];
        if (!eventType) {
          continue;
        }

        // Check if this is a consensus-related log
        if (this.isConsensusTarget(log.target)) {
          const event = await this.parseConsensusEventAsync(log, validatorInfoMap);
          if (event) {
            consensusEvents.push(event);
          }
        } else if (this.isLedgerTarget(log.target)) {
          const event = await this.parseLedgerEventAsync(log, validatorInfoMap);
          if (event) {
            ledgerEvents.push(event);
          }
        }
      } catch (error) {
        errors.push(`Error processing log ${i}: ${error}`);
      }
    }

    // Process QC participation data
    try {
      const qcData = await this.qcParser.parseQCParticipation(consensusEvents);
      qcParticipationData.push(...qcData);
    } catch (error) {
      errors.push(`QC parsing error: ${error}`);
      }
      
      // Build vote chains
    try {
      const chains = this.voteChainBuilder.buildVoteChains(consensusEvents);
      voteChains.push(...chains);
    } catch (error) {
      errors.push(`Vote chain building error: ${error}`);
    }

    const processingTime = Date.now() - startTime;

    return {
      consensusEvents,
      ledgerEvents,
      qcParticipationData,
      voteChains,
      validatorInfrastructure: [], // Will be populated from cache if needed
      errors,
      processingTimeMs: processingTime,
      processedLogs: logs.length,
      successfullyParsed: consensusEvents.length + ledgerEvents.length
    };
  }

  private async parseConsensusEventAsync(
    log: RawLog, 
    validatorInfoMap: Map<string, CompleteValidatorInfo>
  ): Promise<ConsensusEvent | null> {
    const fields = log.fields;
    const message = fields.message;
    
    if (!message || !EventTypeMapping[message]) {
      return null;
    }

    const timestamp = new Date(log.timestamp);
    const eventType = EventTypeMapping[message];
    const ingestionId = uuidv4();
    const validatorId = this.extractValidatorId(fields, log.target);

    const enhanced = await this.enhanceConsensusEventV3(
      { timestamp, eventType, validatorId, ingestionId },
      fields,
      eventType,
      validatorInfoMap
    );

    return enhanced;
  }

  private async enhanceConsensusEventV3(
    baseEvent: any, 
    fields: any, 
    eventType: EventType,
    validatorInfoMap: Map<string, CompleteValidatorInfo>
  ): Promise<ConsensusEvent> {
    const enhanced: ConsensusEvent = {
      timestamp: baseEvent.timestamp,
      eventType: baseEvent.eventType,
      validatorId: baseEvent.validatorId,
      roundNumber: parseInt(fields.round) || 0,
      epochNumber: parseInt(fields.epoch) || 1,
      blockNumber: fields.block_num ? parseInt(fields.block_num) : undefined,
      blockId: fields.block_id || undefined,
      parentVoteId: fields.parent_vote_id || undefined,
      parentRound: fields.parent_round ? parseInt(fields.parent_round) : undefined,
      nextLeaderId: fields.next_leader_id || undefined,
      blockTimestampMs: fields.block_timestamp_ms ? parseInt(fields.block_timestamp_ms) : undefined,
      processingTimestampMs: Date.now(),
      processingDelayMs: 0,
      transactionCount: fields.transaction_count ? parseInt(fields.transaction_count) : 0,
      stateRootAction: fields.state_root_action || undefined,
      sequenceNumber: fields.sequence_number ? parseInt(fields.sequence_number) : undefined,
      isSuccessful: true,
      participantCount: fields.participant_count ? parseInt(fields.participant_count) : undefined,
      participationRate: fields.participation_rate ? parseFloat(fields.participation_rate) : undefined,
      metadata: JSON.stringify(fields),
      ingestionId: baseEvent.ingestionId,

      // Enhanced fields using pre-cached validator information
      validatorDns: '',
      geographicRegion: 'unknown',
      infrastructureProvider: 'unknown',
      datacenterCode: 'unknown'
    };

    // Get validator information from pre-cached map
    const validatorInfo = validatorInfoMap.get(this.normalizeValidatorId(enhanced.validatorId));
    if (validatorInfo) {
      enhanced.validatorDns = validatorInfo.dnsAddress || '';
      enhanced.geographicRegion = validatorInfo.location || 'unknown';
      enhanced.infrastructureProvider = validatorInfo.provider || 'unknown';
      enhanced.datacenterCode = validatorInfo.datacenter || 'unknown';
    } else {
      // Fallback to domain-based extraction if no cached info
    const validatorDns = this.extractValidatorDns(fields);
    if (validatorDns) {
        enhanced.validatorDns = validatorDns;
        enhanced.infrastructureProvider = this.extractProviderFromDomain(validatorDns);
      }
    }

    return enhanced;
  }

  private async parseLedgerEventAsync(
    log: RawLog,
    validatorInfoMap: Map<string, CompleteValidatorInfo>
  ): Promise<LedgerEvent | null> {
    const fields = log.fields;
    const message = fields.message;
    
    if (!message || !EventTypeMapping[message]) {
      return null;
    }

    const timestamp = new Date(log.timestamp);
    const eventType = EventTypeMapping[message];
    const ingestionId = uuidv4();
    const validatorId = this.extractValidatorId(fields, log.target);

    // Get validator information from pre-cached map
    const validatorInfo = validatorInfoMap.get(this.normalizeValidatorId(validatorId));

    let geographicRegion = 'unknown';
    let infrastructureProvider = 'unknown';
    let datacenterCode = 'unknown';

    if (validatorInfo) {
      geographicRegion = validatorInfo.location || 'unknown';
      infrastructureProvider = validatorInfo.provider || 'unknown';
      datacenterCode = validatorInfo.datacenter || 'unknown';
    } else {
      // Fallback to domain-based extraction
      const validatorDns = this.extractValidatorDns(fields);
    if (validatorDns) {
        infrastructureProvider = this.extractProviderFromDomain(validatorDns);
      }
    }

    const ledgerEvent: LedgerEvent = {
      timestamp,
      eventType,
      validatorId,
      roundNumber: parseInt(fields.round) || 0,
      epochNumber: parseInt(fields.epoch) || 1,
      blockNumber: fields.block_num ? parseInt(fields.block_num) : undefined,
      parentRound: fields.parent_round ? parseInt(fields.parent_round) : undefined,
      sequenceNumber: fields.sequence_number ? parseInt(fields.sequence_number) : undefined,
      transactionCount: fields.transaction_count ? parseInt(fields.transaction_count) : 0,
      blockTimestampMs: fields.block_timestamp_ms ? parseInt(fields.block_timestamp_ms) : Date.now(),
      processingTimestampMs: Date.now(),
      processingDelayMs: 0,
      
      // Enhanced fields using pre-cached information
      validatorDns: validatorInfo?.dnsAddress || '',
      geographicRegion,
      infrastructureProvider,
      datacenterCode,
      
      ingestionId
    };

    return ledgerEvent;
  }

  // =============================================
  // ENHANCED VALIDATOR INFRASTRUCTURE EXTRACTION
  // =============================================

  private async extractValidatorInfrastructureEnhanced(events: ParsedEvent[]): Promise<ValidatorInfrastructure[]> {
    const validatorIds = new Set<string>();
    
    events.forEach(event => {
      if (event.validatorId && event.validatorId !== 'unknown') {
        validatorIds.add(event.validatorId);
      }
    });

    const validatorInfoMap = await this.validatorInfoService.batchGetValidatorInfo(
      Array.from(validatorIds)
    );
    
    const infrastructure: ValidatorInfrastructure[] = [];
    
    for (const [validatorId, validatorInfo] of validatorInfoMap) {
      infrastructure.push({
        validatorId,
        dnsName: validatorInfo.dnsHost || 'unknown',
        geographicRegion: validatorInfo.location || 'unknown',
        infrastructureProvider: validatorInfo.provider || 'unknown',
        datacenterCode: validatorInfo.datacenter || 'unknown',
        providerType: this.classifyProviderType(validatorInfo.provider || 'unknown'),
        endpointHost: validatorInfo.dnsHost || 'unknown',
        endpointPort: validatorInfo.dnsPort || 8000
      });
    }

    return infrastructure;
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  private isConsensusTarget(target: string): boolean {
    return target.includes('consensus') || 
           target.includes('monad_consensus') ||
           target.includes('monad_eth_block_policy') ||
           target.includes('pacemaker');
  }

  private isLedgerTarget(target: string): boolean {
    return target === 'ledger_tail' || target.includes('ledger');
  }

  private extractValidatorId(fields: any, target: string): string {
    // Try various field names based on log type
    return fields.author || 
           fields.validator_id || 
           fields.proposer_id || 
           fields.leader_id || 
           'unknown';
    }
    
  private extractValidatorDns(fields: any): string | null {
    // Try to extract DNS from various fields
    return fields.dns_address || 
           fields.validator_dns || 
           fields.endpoint || 
           null;
  }

  private extractProviderFromDomain(domain: string): string {
    const hostname = domain.split(':')[0].toLowerCase();
    
    if (hostname.includes('monadinfra')) return 'MonadInfra';
    if (hostname.includes('aws') || hostname.includes('amazon')) return 'AWS';
    if (hostname.includes('gcp') || hostname.includes('google')) return 'Google Cloud';
    if (hostname.includes('azure') || hostname.includes('microsoft')) return 'Azure';
    if (hostname.includes('digitalocean')) return 'DigitalOcean';
    if (hostname.includes('vultr')) return 'Vultr';
    if (hostname.includes('linode')) return 'Linode';
    if (hostname.includes('hetzner')) return 'Hetzner';
    
    return 'Community';
  }

  private classifyProviderType(provider: string): 'monadinfra' | 'community' | 'enterprise' {
    const lowerProvider = provider.toLowerCase();
    
    if (lowerProvider.includes('monadinfra') || lowerProvider.includes('monad')) {
      return 'monadinfra';
    }
    
    if (lowerProvider.includes('aws') || 
        lowerProvider.includes('google') || 
        lowerProvider.includes('azure') || 
        lowerProvider.includes('oracle')) {
      return 'enterprise';
    }
    
      return 'community';
    }

  private normalizeValidatorId(validatorId: string): string {
    return validatorId.startsWith('0x') ? validatorId.slice(2) : validatorId;
  }

  // Set current epoch for validator info service
  setCurrentEpoch(epoch: number): void {
    this.validatorInfoService.setCurrentEpoch(epoch);
  }

  // Get validator info service stats
  getValidatorStats() {
    return this.validatorInfoService.getStats();
  }
}

// =============================================
// IMPLEMENTATION CLASSES
// =============================================

interface QCParticipationParser {
  parseQCParticipation(events: ConsensusEvent[]): Promise<QCParticipationData[]>;
}

interface VoteChainBuilder {
  buildVoteChains(events: ConsensusEvent[]): VoteChain[];
}

class QCParticipationParserImpl implements QCParticipationParser {
  constructor(private validatorInfoService: ValidatorInfoService) {}

  async parseQCParticipation(events: ConsensusEvent[]): Promise<QCParticipationData[]> {
    const qcEvents = events.filter(e => 
      e.eventType === EventType.QC_COMMIT_TRIGGERED || 
      e.eventType === EventType.QC_COMMIT_ATTEMPT
    );

    const qcData: QCParticipationData[] = [];

    for (const event of qcEvents) {
      if (event.participantCount && event.participationRate) {
        qcData.push({
          timestamp: event.timestamp,
          roundNumber: event.roundNumber,
          epochNumber: event.epochNumber,
          participantCount: event.participantCount,
          participationRate: event.participationRate,
          validatorId: event.validatorId,
          qcId: `${event.roundNumber}-${event.epochNumber}`,
          blockId: event.blockId || '',
          processingLatencyMs: event.processingDelayMs,
          // Additional fields for ClickHouse storage
          totalValidators: event.participantCount || 0,
          participatingValidators: Math.round((event.participantCount || 0) * (event.participationRate || 0) / 100),
          participationBitmap: '', // Would need to be extracted from QC data if available
          blsSignature: '', // Would need to be extracted from QC data if available
          signatureVerificationTimeNs: undefined,
          qcAssemblyTimeMs: event.processingDelayMs,
          validatorParticipation: [] // Would need to be populated from QC bitvec if available
        });
      }
    }

    return qcData;
  }
}

class VoteChainBuilderImpl implements VoteChainBuilder {
  buildVoteChains(events: ConsensusEvent[]): VoteChain[] {
    const voteEvents = events.filter(e => 
      e.eventType === EventType.VOTE_ATTEMPT || 
      e.eventType === EventType.VOTE_RESULT || 
      e.eventType === EventType.VOTE_CREATED
    );

    const chains: Map<string, VoteChain> = new Map();

    for (const event of voteEvents) {
      const chainId = `${event.roundNumber}-${event.epochNumber}`;
      
      if (!chains.has(chainId)) {
        chains.set(chainId, {
          chainId,
          roundNumber: event.roundNumber,
          epochNumber: event.epochNumber,
          votes: [],
          startTime: event.timestamp,
          endTime: event.timestamp,
          totalVotes: 0,
          successfulVotes: 0
        });
      }

      const chain = chains.get(chainId)!;
      
      const voteInfo: VoteInfo = {
        validatorId: event.validatorId,
        voteType: event.eventType.toString(),
        timestamp: event.timestamp,
        successful: event.isSuccessful,
        processingDelayMs: event.processingDelayMs
      };

      chain.votes.push(voteInfo);
      chain.totalVotes++;
      if (event.isSuccessful) chain.successfulVotes++;
      
      if (event.timestamp > chain.endTime) chain.endTime = event.timestamp;
      if (event.timestamp < chain.startTime) chain.startTime = event.timestamp;
    }
    
    return Array.from(chains.values());
  }
}
