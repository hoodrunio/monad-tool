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
  ValidatorRegistryEntry,
  BftVoteEvent,
  BftRoundStateEvent,
  BftEnhancedLogProcessingResult
} from './types';

import { ValidatorService, CompleteValidator } from '../services/unified-validator';
import { MonadClickHouseClient } from '../database/clickhouse-client';
import { ServiceContainer } from '../services/service-container';
import { logger } from '../utils/logger';
import { EpochService } from '../services/epoch/EpochService';
import { NodeRpcClient } from '../services/blockchain/NodeRpcClient';

export class FocusedLogProcessor {
  private validatorService: ValidatorService | null = null;
  private clickhouseClient: MonadClickHouseClient | null = null;
  private validatorRegistry: Map<number, ValidatorRegistryEntry> = new Map();
  // Add reverse mapping for BitVec index to validator position
  private bitVecIndexToPosition: Map<number, number> = new Map();
  private isInitialized: boolean = false;
  private lastLedgerSeqNum: number = 0;
  private lastLedgerEpoch: number = 1;

  constructor(clickhouseClient?: MonadClickHouseClient) {
    this.clickhouseClient = clickhouseClient || ServiceContainer.getInstance().getClickHouseClient();
  }

  async initialize(): Promise<void> {
    if (!this.isInitialized) {
      logger.info('🔧 Initializing Focused Log Processor...');
      
      // Get validator service from service container (it's already initialized with the correct epoch)
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

  async processLogBatch(logs: RawLog[]): Promise<BftEnhancedLogProcessingResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const startTime = Date.now();
    const blockProposalEvents: BlockProposalEvent[] = [];
    const qcParticipationEvents: QCParticipationEvent[] = [];
    const bftVoteEvents: BftVoteEvent[] = [];
    const bftRoundStates: BftRoundStateEvent[] = [];
    const errors: string[] = [];

    logger.info(`📋 Processing batch of ${logs.length} logs for separate metrics...`);

    // Process logs directly without enrichment (provider/location comes from validator_registry via JOINs)
    for (const log of logs) {
      try {
        const fields = log.fields;
        if (!fields || !fields.message) continue;

        // Process ledger logs for block proposals
        if (this.isLedgerTarget(log.target)) {
          const blockEvent = this.extractBlockProposal(log, fields);
          if (blockEvent) {
            blockProposalEvents.push(blockEvent);
          }
        }

        // Process BFT logs for QC participation and consensus tracking
        if (this.isConsensusTarget(log.target)) {
          // Existing QC participation extraction
          const qcEvents = this.extractQCParticipation(log, fields, errors);
          if (qcEvents.length > 0) {
            qcParticipationEvents.push(...qcEvents);
          }

          // NEW: BFT vote message extraction
          const voteEvent = this.extractBftVoteMessage(log, fields);
          if (voteEvent) {
            bftVoteEvents.push(voteEvent);
          }

          // NEW: BFT round state extraction
          const roundState = this.extractBftRoundState(log, fields);
          if (roundState) {
            bftRoundStates.push(roundState);
          }
        }
      } catch (error) {
        errors.push(`Error processing log: ${error}`);
      }
    }

    const processingTime = Date.now() - startTime;

    logger.info(`✅ Processed ${blockProposalEvents.length} block proposals, ${qcParticipationEvents.length} QC participations, ${bftVoteEvents.length} BFT votes, ${bftRoundStates.length} BFT round states in ${processingTime}ms`);

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

      // NEW: BFT consensus tracking
      bftVoteEvents,
      bftRoundStates,

      // Metadata
      errors,
      processingTimeMs: processingTime,
      processedLogs: logs.length,
      successfullyParsed: blockProposalEvents.length + qcParticipationEvents.length + bftVoteEvents.length + bftRoundStates.length
    };
  }

  // =============================================
  // BLOCK PROPOSAL EXTRACTION (from ledger.json)
  // =============================================

  private extractBlockProposal(log: RawLog, fields: any): BlockProposalEvent | null {
    const message = fields.message;
    
    // Extract proposed_block events
    if (message === 'proposed_block') {
      const seqNum = parseInt(fields.seq_num) || 0;
      const epochNumber = parseInt(fields.epoch) || 1;
      
      this.lastLedgerSeqNum = seqNum;
      this.lastLedgerEpoch = epochNumber;

      return {
        timestamp: new Date(log.timestamp),
        validatorId: this.normalizeValidatorId(fields.author || 'unknown'),
        seqNum,
        roundNumber: parseInt(fields.round) || 0,
        epochNumber,
        status: 'proposed',
        numTx: parseInt(fields.num_tx) || 0,
        blockId: fields.seq_num || undefined,
        
        // Infrastructure will be populated by enhanceEventsWithInfrastructure
        validatorDns: fields.author_address || '',
        geographicRegion: 'unknown',
        infrastructureProvider: 'unknown',
        
        ingestionId: uuidv4()
      };
    }

    // Track finalized_block events for sequence number updates but don't create separate proposals
    if (message === 'finalized_block') {
      const seqNum = parseInt(fields.seq_num) || 0;
      const epochNumber = parseInt(fields.epoch) || 1;
      
      this.lastLedgerSeqNum = seqNum;
      this.lastLedgerEpoch = epochNumber;

      // Don't return a BlockProposalEvent - finalized blocks are just confirmations
      // of already proposed blocks, not new proposals
      return null;
    }

    // Extract timeout events (previously skipped_block)
    if (message === 'timeout') {
      return {
        timestamp: new Date(log.timestamp),
        validatorId: this.normalizeValidatorId(fields.author || 'unknown'),
        seqNum: this.lastLedgerSeqNum,
        roundNumber: parseInt(fields.round) || 0,
        epochNumber: this.lastLedgerEpoch,
        status: 'skipped',
        numTx: 0,
        blockId: String(this.lastLedgerSeqNum) || undefined,
        
        // Infrastructure will be populated by enhanceEventsWithInfrastructure
        validatorDns: fields.author_address || '',
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
        const qcData = this.parseQCData(fields);
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

  private parseQCData(fields: any): ParsedQCData | null {
    const qcString = fields.qc as string;
    if (!qcString) {
        return null;
    }
    
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
      
      // Extract round, epoch, and blockId from QC data
      const roundMatch = qcString.match(/r:\s*(\d+)/);
      const epochMatch = qcString.match(/epoch:\s*(\d+)/);
      const blockIdMatch = qcString.match(/id:\s*([a-zA-Z0-9\.]+)/);
      
      const round = fields.round ? parseInt(fields.round) : (roundMatch ? parseInt(roundMatch[1]) : 0);
      const epoch = fields.epoch ? parseInt(fields.epoch) : (epochMatch ? parseInt(epochMatch[1]) : 1);
      const blockId = blockIdMatch ? blockIdMatch[1] : 'unknown';
      
      const totalValidators = signerBits.length;
      const participatingValidators = signerBits.filter(bit => bit === 1).length;

      return {
        signerBits,
        round,
        epoch,
        totalValidators,
        participatingValidators,
        blockId
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
    
    // seqNum is not available in this log, it will be derived from blockId in the API layer
    const seqNum = 0;

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
        qcId: qcData.blockId,
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
  // NOTE: Infrastructure enrichment removed
  // Provider/location data now comes from validator_registry via JOINs in API queries
  // This improves performance and ensures data consistency
  // =============================================

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
  // BFT CONSENSUS TRACKING (NEW)
  // =============================================

  /**
   * Extract BFT vote message event
   * Parses "vote message" logs to extract validator signatures
   */
  private extractBftVoteMessage(log: RawLog, fields: any): BftVoteEvent | null {
    const message = fields.message;

    if (message !== 'vote message') {
      return null;
    }

    try {
      const author = fields.author;
      const voteMsgString = fields.vote_msg;

      if (!author || !voteMsgString) {
        return null;
      }

      // Extract vote ID: "Vote { id: 9db8..cabe, epoch: 619, round: 3279267 }"
      const voteMatch = String(voteMsgString).match(/id:\s*([0-9a-f.]+).*epoch:\s*(\d+).*round:\s*(\d+)/);
      if (!voteMatch) {
        return null;
      }

      const voteId = voteMatch[1];
      const epoch = Number(voteMatch[2]);
      const round = Number(voteMatch[3]);

      // Extract BLS signature: BlsSignature("...")
      const sigMatch = String(voteMsgString).match(/BlsSignature\("(.+?)"\)/);
      const sig = sigMatch ? sigMatch[1] : '';

      if (!sig) {
        return null;
      }

      // Generate event ID for deduplication (SHA1 hash)
      const crypto = require('crypto');
      const eventId = crypto
        .createHash('sha1')
        .update(`${author}${epoch}${round}${voteId}`)
        .digest('hex');

      return {
        timestamp: new Date(log.timestamp),
        epoch,
        round,
        author,
        sig,
        voteId,
        eventId
      };
    } catch (error) {
      logger.warn(`Failed to parse BFT vote message: ${error}`);
      return null;
    }
  }

  /**
   * Extract BFT round state event
   * Parses "collecting vote" logs to track stake accumulation
   */
  private extractBftRoundState(log: RawLog, fields: any): BftRoundStateEvent | null {
    const message = fields.message;

    if (message !== 'collecting vote') {
      return null;
    }

    try {
      const roundStr = fields.round;
      const epochStr = fields.epoch;
      const currentStakeStr = fields.current_stake;
      const totalStakeStr = fields.total_stake;

      if (!roundStr || !epochStr || !currentStakeStr || !totalStakeStr) {
        return null;
      }

      const round = Number(roundStr);
      const epoch = Number(epochStr);

      // Parse stake values: "Ok(Stake(1273254265463543980894843884))" or "Stake(9554473084196538460577820321)"
      const parseStake = (stakeStr: string): bigint => {
        const match = String(stakeStr).match(/(\d+)/);
        return match ? BigInt(match[1]) : 0n;
      };

      const currentStake = parseStake(currentStakeStr);
      const totalStake = parseStake(totalStakeStr);

      // Calculate stake ratio as percentage
      const stakeRatio = totalStake > 0n
        ? (Number(currentStake) / Number(totalStake)) * 100
        : 0;

      // Generate event ID for deduplication
      const crypto = require('crypto');
      const eventId = crypto
        .createHash('sha1')
        .update(`${epoch}${round}${currentStake}${totalStake}`)
        .digest('hex');

      return {
        timestamp: new Date(log.timestamp),
        epoch,
        round,
        currentStake,
        totalStake,
        stakeRatio,
        eventId
      };
    } catch (error) {
      logger.warn(`Failed to parse BFT round state: ${error}`);
      return null;
    }
  }

  /**
   * Insert BFT vote events into ClickHouse
   */
  async insertBftVotes(events: BftVoteEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    if (!this.clickhouseClient) {
      logger.warn('💾 No ClickHouse client available, skipping BFT vote insertion');
      return;
    }

    try {
      const values = events.map(event => ({
        ts: event.timestamp.toISOString(),
        epoch: event.epoch,
        round: event.round,
        author: event.author,
        sig: event.sig,
        vote_id: event.voteId,
        event_id: event.eventId
      }));

      await this.clickhouseClient.getClient().insert({
        table: 'bft_votes',
        values,
        format: 'JSONEachRow'
      });

      logger.info(`💾 Successfully inserted ${events.length} BFT vote events`);
    } catch (error) {
      logger.error('Failed to insert BFT votes:', error);
      throw error;
    }
  }

  /**
   * Insert BFT round state events into ClickHouse
   */
  async insertBftRoundStates(events: BftRoundStateEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    if (!this.clickhouseClient) {
      logger.warn('💾 No ClickHouse client available, skipping BFT round state insertion');
      return;
    }

    try {
      const values = events.map(event => ({
        ts: event.timestamp.toISOString(),
        epoch: event.epoch,
        round: event.round,
        current_stake: event.currentStake.toString(),
        total_stake: event.totalStake.toString(),
        stake_ratio: event.stakeRatio,
        event_id: event.eventId
      }));

      await this.clickhouseClient.getClient().insert({
        table: 'bft_round_state',
        values,
        format: 'JSONEachRow'
      });

      logger.info(`💾 Successfully inserted ${events.length} BFT round state events`);
    } catch (error) {
      logger.error('Failed to insert BFT round states:', error);
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
