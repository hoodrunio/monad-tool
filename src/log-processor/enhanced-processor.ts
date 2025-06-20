// Monad Validator Analytics - Focused Log Processor
// Focus: Block Proposals (ledger.json) + QC Participation (monad-bft.json BitVec)
// Removes generic event processing and focuses on actual consensus data

import { v4 as uuidv4 } from 'uuid';
import {
  RawLog,
  BlockProposalEvent,
  QCParticipationEvent,
  EnhancedLogProcessingResult,
  ParsedQCData,
  ValidatorRegistryEntry
} from './types';

import { ValidatorService, CompleteValidator } from '../services/unified-validator';
import { MonadClickHouseClient } from '../database/clickhouse-client';
import { logger } from '../utils/logger';
import { validatorRegistry } from '../services/validator-registry';

export class FocusedLogProcessor {
  private validatorService: ValidatorService;
  private clickhouseClient: MonadClickHouseClient | null = null;
  private validatorRegistry: Map<number, ValidatorRegistryEntry> = new Map();
  private isInitialized: boolean = false;

  constructor(clickhouseClient?: MonadClickHouseClient) {
    this.validatorService = new ValidatorService();
    this.clickhouseClient = clickhouseClient || null;
  }

  async initialize(): Promise<void> {
    if (!this.isInitialized) {
      logger.info('🔧 Initializing Focused Log Processor...');
      
      await this.validatorService.initialize();
      await this.loadValidatorRegistry();
      
      this.isInitialized = true;
      logger.info('✅ Focused processor initialized with validator registry');
    }
  }

  async processLogBatch(logs: RawLog[]): Promise<EnhancedLogProcessingResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const startTime = Date.now();
    const blockProposalEvents: BlockProposalEvent[] = [];
    const qcParticipationEvents: QCParticipationEvent[] = [];
    const errors: string[] = [];

    logger.info(`📋 Processing batch of ${logs.length} logs for separate metrics...`);

    // Extract validator infrastructure data once
    const validatorIds = new Set<string>();
    const validatorInfoMap = new Map<string, CompleteValidator>();

    for (const log of logs) {
      try {
        const fields = log.fields;
        if (!fields || !fields.message) continue;

        // Process ledger logs for block proposals
        if (this.isLedgerTarget(log.target)) {
          const blockEvent = this.extractBlockProposal(log, fields);
          if (blockEvent) {
            blockProposalEvents.push(blockEvent);
            validatorIds.add(blockEvent.validatorId);
          }
        }

        // Process BFT logs for QC participation
        if (this.isConsensusTarget(log.target)) {
          const qcEvents = this.extractQCParticipation(log, fields);
          if (qcEvents.length > 0) {
            qcParticipationEvents.push(...qcEvents);
            qcEvents.forEach(event => validatorIds.add(event.validatorId));
          }
        }
      } catch (error) {
        errors.push(`Error processing log: ${error}`);
      }
    }

    // Batch fetch validator infrastructure info
    if (validatorIds.size > 0) {
      const batchInfo = await this.validatorService.getValidators(Array.from(validatorIds));
      validatorInfoMap.clear();
      batchInfo.forEach((validator, id) => validatorInfoMap.set(id, validator));
    }

    // Enhance events with infrastructure data
    this.enhanceBlockProposalEvents(blockProposalEvents, validatorInfoMap);
    this.enhanceQCParticipationEvents(qcParticipationEvents, validatorInfoMap);

    const processingTime = Date.now() - startTime;

    logger.info(`✅ Processed ${blockProposalEvents.length} block proposals and ${qcParticipationEvents.length} QC participations in ${processingTime}ms`);

    return {
      // Legacy fields (empty for compatibility)
      consensusEvents: [],
      ledgerEvents: [],
      qcParticipationData: [],
      voteChains: [],
      validatorInfrastructure: [],
      
      // New focused fields
      blockProposalEvents,
      qcParticipationEvents,
      separateMetrics: [],
      
      // Metadata
      errors,
      processingTimeMs: processingTime,
      processedLogs: logs.length,
      successfullyParsed: blockProposalEvents.length + qcParticipationEvents.length
    };
  }

  // =============================================
  // BLOCK PROPOSAL EXTRACTION (from ledger.json)
  // =============================================

  private extractBlockProposal(log: RawLog, fields: any): BlockProposalEvent | null {
    const message = fields.message;
    
    // Extract proposed_block events
    if (message === 'proposed_block') {
      return {
        timestamp: new Date(log.timestamp),
        validatorId: this.normalizeValidatorId(fields.author || 'unknown'),
        seqNum: parseInt(fields.seq_num) || 0,
        roundNumber: parseInt(fields.round) || 0,
        epochNumber: parseInt(fields.epoch) || 1,
        status: 'proposed',
        numTx: parseInt(fields.num_tx) || 0,
        blockId: fields.block_id || undefined,
        
        // Infrastructure will be populated by enhanceBlockProposalEvents
        validatorDns: '',
        geographicRegion: 'unknown',
        infrastructureProvider: 'unknown',
        
        ingestionId: uuidv4()
      };
    }

    // Extract skipped_block events
    if (message === 'skipped_block') {
      return {
        timestamp: new Date(log.timestamp),
        validatorId: this.normalizeValidatorId(fields.author || 'unknown'),
        seqNum: 0, // May not be available for skipped blocks
        roundNumber: parseInt(fields.round) || 0,
        epochNumber: parseInt(fields.epoch) || 1,
        status: 'skipped',
        numTx: 0,
        blockId: undefined,
        
        // Infrastructure will be populated by enhanceBlockProposalEvents
        validatorDns: '',
        geographicRegion: 'unknown',
        infrastructureProvider: 'unknown',
        
        ingestionId: uuidv4()
      };
    }

    return null;
  }

  // =============================================
  // QC PARTICIPATION EXTRACTION (from monad-bft.json)
  // =============================================

  private extractQCParticipation(log: RawLog, fields: any): QCParticipationEvent[] {
    const message = fields.message;
    
    // Look for QC commit events with BitVec data
    if (message === 'try committing blocks using qc' && fields.qc) {
      try {
        const qcData = this.parseQCData(fields.qc);
        if (qcData) {
          return this.extractValidatorParticipation(qcData, log.timestamp, fields);
        }
      } catch (error) {
        logger.warn(`Failed to parse QC data: ${error}`);
      }
    }

    return [];
  }

  private parseQCData(qcString: string): ParsedQCData | null {
    try {
      // Extract BitVec from QC string
      // Expected format: "QC { ... signers: SignerMap(BitVec<u8, bitvec::order::Lsb0> { bits: 169, capacity: 176 } [0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, ...] }"
      const bitVecMatch = qcString.match(/\[([0-9, ]+)\]/);
      if (!bitVecMatch) {
        logger.warn('No BitVec found in QC string');
        return null;
      }

      const bitVecString = bitVecMatch[1];
      const signerBits = bitVecString.split(',').map(b => parseInt(b.trim()));
      
      // Extract round and epoch from QC data
      const roundMatch = qcString.match(/round:\s*(\d+)/);
      const epochMatch = qcString.match(/epoch:\s*(\d+)/);
      
      const round = roundMatch ? parseInt(roundMatch[1]) : 0;
      const epoch = epochMatch ? parseInt(epochMatch[1]) : 1;
      
      const totalValidators = signerBits.length;
      const participatingValidators = signerBits.filter(bit => bit === 1).length;

      return {
        signerBits,
        round,
        epoch,
        totalValidators,
        participatingValidators
      };
    } catch (error) {
      logger.error(`Error parsing QC data: ${error}`);
      return null;
    }
  }

  private extractValidatorParticipation(
    qcData: ParsedQCData, 
    timestamp: string, 
    fields: any
  ): QCParticipationEvent[] {
    const events: QCParticipationEvent[] = [];
    const participationRate = qcData.participatingValidators / qcData.totalValidators * 100;
    
    // Extract seq_num if available
    const seqNum = parseInt(fields.seq_num) || 0;

    qcData.signerBits.forEach((participated, index) => {
      // Map validator index to validator ID
      const validatorEntry = this.validatorRegistry.get(index);
      const validatorId = validatorEntry?.validatorId || `unknown_${index}`;

      events.push({
        timestamp: new Date(timestamp),
        validatorId: this.normalizeValidatorId(validatorId),
        seqNum,
        roundNumber: qcData.round,
        epochNumber: qcData.epoch,
        participated: participated === 1,
        validatorIndex: index,
        
        // QC metadata
        qcId: `${qcData.round}-${qcData.epoch}`,
        totalValidators: qcData.totalValidators,
        participatingValidators: qcData.participatingValidators,
        participationRate,
        
        // Infrastructure will be populated by enhanceQCParticipationEvents
        validatorDns: '',
        geographicRegion: 'unknown',
        infrastructureProvider: 'unknown',
        
        ingestionId: uuidv4()
      });
    });

    return events;
  }

  // =============================================
  // INFRASTRUCTURE ENHANCEMENT
  // =============================================

  private enhanceBlockProposalEvents(
    events: BlockProposalEvent[], 
    validatorInfoMap: Map<string, CompleteValidator>
  ): void {
    events.forEach(event => {
      const validator = validatorInfoMap.get(this.normalizeValidatorId(event.validatorId));
      if (validator && validator.location) {
        event.validatorDns = validator.location.dnsAddress || '';
        event.geographicRegion = validator.location.city && validator.location.country ? 
          `${validator.location.city}, ${validator.location.country}` : 'unknown';
        event.infrastructureProvider = validator.location.isp || 'unknown';
      }
    });
  }

  private enhanceQCParticipationEvents(
    events: QCParticipationEvent[], 
    validatorInfoMap: Map<string, CompleteValidator>
  ): void {
    events.forEach(event => {
      const validator = validatorInfoMap.get(this.normalizeValidatorId(event.validatorId));
      if (validator && validator.location) {
        event.validatorDns = validator.location.dnsAddress || '';
        event.geographicRegion = validator.location.city && validator.location.country ? 
          `${validator.location.city}, ${validator.location.country}` : 'unknown';
        event.infrastructureProvider = validator.location.isp || 'unknown';
      }
    });
  }

  // =============================================
  // VALIDATOR REGISTRY MANAGEMENT
  // =============================================

  private async loadValidatorRegistry(): Promise<void> {
    try {
      // Load the actual validator registry from the service
      await validatorRegistry.initialize();
      
      // Get all validators for current epoch
      const validators = validatorRegistry.getAllValidators();
      
      // Populate our internal registry map with validator positions
      this.validatorRegistry.clear();
      validators.forEach(validator => {
        this.validatorRegistry.set(validator.position, {
          position: validator.position,
          validatorId: validator.node_id,
          nodeId: validator.node_id,
          stake: validator.stake
        });
      });
      
      logger.info(`📋 Loaded ${validators.length} validators from registry for epoch ${validatorRegistry.getCurrentEpoch()}`);
    } catch (error) {
      logger.error('Failed to load validator registry:', error);
      // Fall back to dynamic population
      logger.warn('📋 Falling back to dynamic validator population');
    }
  }

  updateValidatorRegistry(epoch: number, validators: ValidatorRegistryEntry[]): void {
    this.validatorRegistry.clear();
    validators.forEach(validator => {
      this.validatorRegistry.set(validator.position, validator);
    });
    logger.info(`📋 Updated validator registry for epoch ${epoch} with ${validators.length} validators`);
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  private isLedgerTarget(target: string): boolean {
    return target === 'ledger_tail' || target.includes('ledger');
  }

  private isConsensusTarget(target: string): boolean {
    return target.includes('consensus') || 
           target.includes('monad_consensus') ||
           target.includes('monad_eth_block_policy') ||
           target.includes('pacemaker');
  }

  private normalizeValidatorId(validatorId: string): string {
    if (!validatorId || validatorId === 'unknown') {
      return 'unknown';
    }
    return validatorId.startsWith('0x') ? validatorId.slice(2) : validatorId;
  }

  // =============================================
  // DATABASE INSERTION METHODS
  // =============================================

  async insertBlockProposals(events: BlockProposalEvent[]): Promise<void> {
    if (events.length === 0) return;

    if (!this.clickhouseClient) {
      logger.warn('💾 No ClickHouse client available, skipping block proposal insertion');
      return;
    }

    try {
      await this.clickhouseClient.insertBlockProposals(events);
      logger.info(`💾 Successfully inserted ${events.length} block proposal events`);
    } catch (error) {
      logger.error('Failed to insert block proposals:', error);
      throw error;
    }
  }

  async insertQCParticipations(events: QCParticipationEvent[]): Promise<void> {
    if (events.length === 0) return;

    if (!this.clickhouseClient) {
      logger.warn('💾 No ClickHouse client available, skipping QC participation insertion');
      return;
    }

    try {
      await this.clickhouseClient.insertQCParticipations(events);
      logger.info(`💾 Successfully inserted ${events.length} QC participation events`);
    } catch (error) {
      logger.error('Failed to insert QC participations:', error);
      throw error;
    }
  }

  // =============================================
  // STATISTICS AND MONITORING
  // =============================================

  getProcessingStats(): any {
    return {
      validatorRegistrySize: this.validatorRegistry.size,
      isInitialized: this.isInitialized,
      validatorService: this.validatorService.getStats()
    };
  }
}
