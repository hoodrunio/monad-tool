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
import { ServiceContainer } from '../services/service-container';
import { logger } from '../utils/logger';

export class FocusedLogProcessor {
  private validatorService: ValidatorService | null = null;
  private clickhouseClient: MonadClickHouseClient | null = null;
  private validatorRegistry: Map<number, ValidatorRegistryEntry> = new Map();
  // Add reverse mapping for BitVec index to validator position
  private bitVecIndexToPosition: Map<number, number> = new Map();
  private isInitialized: boolean = false;

  constructor(clickhouseClient?: MonadClickHouseClient) {
    this.clickhouseClient = clickhouseClient || null;
  }

  async initialize(): Promise<void> {
    if (!this.isInitialized) {
      logger.info('🔧 Initializing Focused Log Processor...');
      
      // Get validator service from service container
      const serviceContainer = ServiceContainer.getInstance();
      this.validatorService = serviceContainer.getValidatorService();
      
      // Get current epoch and populate validator registry maps
      const currentEpoch = this.validatorService.getCurrentEpoch();
      const validators = await this.validatorService.getAllValidators(currentEpoch);
      
      // Convert CompleteValidator[] to ValidatorRegistryEntry[] and populate registry
      const registryEntries = validators.map((validator: CompleteValidator) => ({
        validatorId: validator.nodeId, // Use nodeId as validatorId
        nodeId: validator.nodeId,
        position: validator.position, // Use the validator's actual position
        epoch: currentEpoch,
        stake: validator.stake || 0,
        isActive: validator.isActive
      }));
      
      this.updateValidatorRegistry(currentEpoch, registryEntries);
      
      this.isInitialized = true;
      logger.info(`✅ Focused processor initialized with ${registryEntries.length} validators for epoch ${currentEpoch}`);
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
          const qcEvents = this.extractQCParticipation(log, fields, errors);
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
    let validatorInfoMap = new Map<string, CompleteValidator>();
    if (validatorIds.size > 0 && this.validatorService) {
      try {
        validatorInfoMap = await this.validatorService.getValidators(Array.from(validatorIds));
      } catch (error) {
        errors.push(`Error fetching validator info: ${error}`);
        logger.error('Failed to fetch validator infrastructure info:', error);
      }
    }

    // Enhance events with infrastructure data
    this.enhanceEventsWithInfrastructure(blockProposalEvents, validatorInfoMap);
    this.enhanceEventsWithInfrastructure(qcParticipationEvents, validatorInfoMap);

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
        
        // Infrastructure will be populated by enhanceEventsWithInfrastructure
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
        seqNum: parseInt(fields.seq_num) || 0, // Try to extract actual seq_num
        roundNumber: parseInt(fields.round) || 0,
        epochNumber: parseInt(fields.epoch) || 1,
        status: 'skipped',
        numTx: 0,
        blockId: undefined,
        
        // Infrastructure will be populated by enhanceEventsWithInfrastructure
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

  private extractQCParticipation(log: RawLog, fields: any, errors: string[]): QCParticipationEvent[] {
    const message = fields.message;
    
    // Look for QC commit events with BitVec data
    if (message === 'try committing blocks using qc' && fields.qc) {
      try {
        const qcData = this.parseQCData(fields.qc);
        if (qcData) {
          return this.extractValidatorParticipation(qcData, log.timestamp, fields);
        }
      } catch (error) {
        const errorMsg = `Failed to parse QC data: ${error}`;
        logger.warn(errorMsg);
        errors.push(errorMsg); // Add to errors array for consistency
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

    qcData.signerBits.forEach((participated, bitVecIndex) => {
      // Map BitVec index to validator position, then to validator ID
      const validatorPosition = this.bitVecIndexToPosition.get(bitVecIndex) ?? bitVecIndex;
      const validatorEntry = this.validatorRegistry.get(validatorPosition);
      const validatorId = validatorEntry?.validatorId || `unknown_pos_${validatorPosition}`;

      events.push({
        timestamp: new Date(timestamp),
        validatorId: this.normalizeValidatorId(validatorId),
        seqNum,
        roundNumber: qcData.round,
        epochNumber: qcData.epoch,
        participated: participated === 1,
        validatorIndex: bitVecIndex,
        
        // QC metadata
        qcId: `${qcData.round}-${qcData.epoch}`,
        totalValidators: qcData.totalValidators,
        participatingValidators: qcData.participatingValidators,
        participationRate,
        
        // Infrastructure will be populated by enhanceEventsWithInfrastructure
        validatorDns: '',
        geographicRegion: 'unknown',
        infrastructureProvider: 'unknown',
        
        ingestionId: uuidv4()
      });
    });

    return events;
  }

  // =============================================
  // INFRASTRUCTURE ENHANCEMENT (CONSOLIDATED)
  // =============================================

  private enhanceEventsWithInfrastructure<T extends { validatorId: string; validatorDns: string; geographicRegion: string; infrastructureProvider: string }>(
    events: T[], 
    validatorInfoMap: Map<string, CompleteValidator>
  ): void {
    events.forEach(event => {
      // ValidatorId is already normalized, no need to normalize again
      const validator = validatorInfoMap.get(event.validatorId);
      if (validator?.location) {
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


  updateValidatorRegistry(epoch: number, validators: ValidatorRegistryEntry[]): void {
    this.validatorRegistry.clear();
    this.bitVecIndexToPosition.clear();
    
    validators.forEach((validator, index) => {
      this.validatorRegistry.set(validator.position, validator);
      this.bitVecIndexToPosition.set(index, validator.position);
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
      validatorService: this.validatorService ? this.validatorService.getStats() : null
    };
  }
}
