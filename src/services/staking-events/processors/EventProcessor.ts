// Staking Event Processor
// Decodes and validates raw blockchain logs into typed staking events

import { ethers, Log } from 'ethers';
import { logger } from '../../../utils/logger';
import {
  IEventProcessor,
  StakingEvent,
  ValidatorCreatedEvent,
  ValidatorStatusChangedEvent,
  DelegateEvent,
  UndelegateEvent,
  WithdrawEvent,
  ClaimRewardsEvent,
  CommissionChangedEvent,
  ValidatorRewardedEvent,
  EpochChangedEvent,
  EVENT_SIGNATURES,
  STAKING_PRECOMPILE_ADDRESS,
  EventProcessingError,
  StakingEventType
} from '../types';

/**
 * Event ABI definitions for decoding
 */
const EVENT_ABIS = {
  ValidatorCreated: 'event ValidatorCreated(uint64 indexed validatorId, address indexed authAddress, uint256 commission)',
  ValidatorStatusChanged: 'event ValidatorStatusChanged(uint64 indexed validatorId, uint256 flags)',
  Delegate: 'event Delegate(uint64 indexed validatorId, address indexed delegator, uint256 amount, uint64 activationEpoch)',
  Undelegate: 'event Undelegate(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 activationEpoch)',
  Withdraw: 'event Withdraw(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 withdrawEpoch)',
  ClaimRewards: 'event ClaimRewards(uint64 indexed validatorId, address indexed delegator, uint256 amount)',
  CommissionChanged: 'event CommissionChanged(uint64 indexed validatorId, uint256 oldCommission, uint256 newCommission)',
  ValidatorRewarded: 'event ValidatorRewarded(uint64 indexed validatorId, address indexed from, uint256 amount)',
  EpochChanged: 'event EpochChanged(uint64 oldEpoch, uint64 newEpoch)'
};

/**
 * Production-ready Event Processor
 */
export class EventProcessor implements IEventProcessor {
  private iface: ethers.Interface;
  private currentEpoch: bigint = BigInt(0);

  constructor(currentEpoch?: bigint) {
    // Create interface with all event ABIs
    const abiFragments = Object.values(EVENT_ABIS);
    this.iface = new ethers.Interface(abiFragments);

    if (currentEpoch !== undefined) {
      this.currentEpoch = currentEpoch;
    }

    logger.info('EventProcessor initialized');
  }

  /**
   * Update current epoch (used for events that don't include epoch in payload)
   */
  public setCurrentEpoch(epoch: bigint): void {
    this.currentEpoch = epoch;
    logger.debug(`EventProcessor epoch updated to ${epoch}`);
  }

  /**
   * Process a single log into a typed staking event
   */
  async processLog(log: Log, blockTimestamp: Date): Promise<StakingEvent | null> {
    try {
      // Validate log
      if (!this.isStakingLog(log)) {
        return null;
      }

      // Get event type from topic
      const eventType = this.getEventType(log.topics[0]);
      if (!eventType) {
        logger.warn('Unknown event signature', { topic: log.topics[0] });
        return null;
      }

      // Decode and convert to typed event
      const typedEvent = await this.decodeEvent(log, eventType, blockTimestamp);

      if (!typedEvent) {
        logger.warn('Failed to decode event', {
          eventType,
          transactionHash: log.transactionHash,
          logIndex: log.index
        });
        return null;
      }

      // Validate event
      if (!this.validateEvent(typedEvent)) {
        logger.warn('Event validation failed', {
          eventType,
          transactionHash: log.transactionHash
        });
        return null;
      }

      logger.debug('Successfully processed event', {
        eventType,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber
      });

      return typedEvent;
    } catch (error) {
      throw new EventProcessingError(
        `Failed to process log: ${error instanceof Error ? error.message : 'Unknown error'}`,
        {
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index
        }
      );
    }
  }

  /**
   * Batch process multiple logs
   */
  async processLogs(logs: Log[], blockTimestamps: Map<number, Date>): Promise<StakingEvent[]> {
    const events: StakingEvent[] = [];
    const errors: Array<{ log: Log; error: Error }> = [];

    for (const log of logs) {
      try {
        const blockTimestamp = blockTimestamps.get(log.blockNumber);
        if (!blockTimestamp) {
          logger.warn('Missing block timestamp', { blockNumber: log.blockNumber });
          continue;
        }

        const event = await this.processLog(log, blockTimestamp);
        if (event) {
          events.push(event);
        }
      } catch (error) {
        errors.push({
          log,
          error: error instanceof Error ? error : new Error('Unknown error')
        });
      }
    }

    if (errors.length > 0) {
      logger.warn(`Failed to process ${errors.length}/${logs.length} logs`, {
        errorCount: errors.length,
        totalLogs: logs.length
      });
    }

    logger.info(`Successfully processed ${events.length}/${logs.length} logs`);
    return events;
  }

  /**
   * Check if log is from staking precompile
   */
  private isStakingLog(log: Log): boolean {
    return log.address.toLowerCase() === STAKING_PRECOMPILE_ADDRESS.toLowerCase();
  }

  /**
   * Get event type from topic (event signature hash)
   */
  private getEventType(topic: string): StakingEventType | null {
    for (const [eventType, signature] of Object.entries(EVENT_SIGNATURES)) {
      if (signature === topic) {
        return eventType as StakingEventType;
      }
    }
    return null;
  }

  /**
   * Decode event based on type
   */
  private async decodeEvent(
    log: Log,
    eventType: StakingEventType,
    blockTimestamp: Date
  ): Promise<StakingEvent | null> {
    try {
      const parsedLog = this.iface.parseLog({
        topics: log.topics as string[],
        data: log.data
      });

      if (!parsedLog) {
        return null;
      }

      const baseEvent = {
        blockNumber: log.blockNumber,
        blockTimestamp,
        transactionHash: log.transactionHash,
        logIndex: log.index,
        epoch: this.currentEpoch
      };

      switch (eventType) {
        case 'ValidatorCreated':
          return this.decodeValidatorCreated(parsedLog, baseEvent);

        case 'ValidatorStatusChanged':
          return this.decodeValidatorStatusChanged(parsedLog, baseEvent);

        case 'Delegate':
          return this.decodeDelegate(parsedLog, baseEvent);

        case 'Undelegate':
          return this.decodeUndelegate(parsedLog, baseEvent);

        case 'Withdraw':
          return this.decodeWithdraw(parsedLog, baseEvent);

        case 'ClaimRewards':
          return this.decodeClaimRewards(parsedLog, baseEvent);

        case 'CommissionChanged':
          return this.decodeCommissionChanged(parsedLog, baseEvent);

        case 'ValidatorRewarded':
          return this.decodeValidatorRewarded(parsedLog, baseEvent);

        case 'EpochChanged':
          return this.decodeEpochChanged(parsedLog, baseEvent);

        default:
          logger.warn('Unhandled event type', { eventType });
          return null;
      }
    } catch (error) {
      logger.error('Failed to decode event', {
        eventType,
        error: error instanceof Error ? error.message : 'Unknown error',
        transactionHash: log.transactionHash
      });
      return null;
    }
  }

  /**
   * Event decoders
   */

  private decodeValidatorCreated(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): ValidatorCreatedEvent {
    return {
      ...baseEvent,
      eventType: 'ValidatorCreated',
      validatorId: BigInt(parsedLog.args.validatorId),
      authAddress: parsedLog.args.authAddress.toLowerCase(),
      commission: BigInt(parsedLog.args.commission)
    };
  }

  private decodeValidatorStatusChanged(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): ValidatorStatusChangedEvent {
    return {
      ...baseEvent,
      eventType: 'ValidatorStatusChanged',
      validatorId: BigInt(parsedLog.args.validatorId),
      flags: BigInt(parsedLog.args.flags)
    };
  }

  private decodeDelegate(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): DelegateEvent {
    return {
      ...baseEvent,
      eventType: 'Delegate',
      validatorId: BigInt(parsedLog.args.validatorId),
      delegator: parsedLog.args.delegator.toLowerCase(),
      amount: BigInt(parsedLog.args.amount),
      activationEpoch: BigInt(parsedLog.args.activationEpoch)
    };
  }

  private decodeUndelegate(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): UndelegateEvent {
    return {
      ...baseEvent,
      eventType: 'Undelegate',
      validatorId: BigInt(parsedLog.args.validatorId),
      delegator: parsedLog.args.delegator.toLowerCase(),
      withdrawId: Number(parsedLog.args.withdrawId),
      amount: BigInt(parsedLog.args.amount),
      activationEpoch: BigInt(parsedLog.args.activationEpoch)
    };
  }

  private decodeWithdraw(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): WithdrawEvent {
    return {
      ...baseEvent,
      eventType: 'Withdraw',
      validatorId: BigInt(parsedLog.args.validatorId),
      delegator: parsedLog.args.delegator.toLowerCase(),
      withdrawId: Number(parsedLog.args.withdrawId),
      amount: BigInt(parsedLog.args.amount),
      withdrawEpoch: BigInt(parsedLog.args.withdrawEpoch)
    };
  }

  private decodeClaimRewards(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): ClaimRewardsEvent {
    return {
      ...baseEvent,
      eventType: 'ClaimRewards',
      validatorId: BigInt(parsedLog.args.validatorId),
      delegator: parsedLog.args.delegator.toLowerCase(),
      amount: BigInt(parsedLog.args.amount)
    };
  }

  private decodeCommissionChanged(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): CommissionChangedEvent {
    return {
      ...baseEvent,
      eventType: 'CommissionChanged',
      validatorId: BigInt(parsedLog.args.validatorId),
      oldCommission: BigInt(parsedLog.args.oldCommission),
      newCommission: BigInt(parsedLog.args.newCommission)
    };
  }

  private decodeValidatorRewarded(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): ValidatorRewardedEvent {
    return {
      ...baseEvent,
      eventType: 'ValidatorRewarded',
      validatorId: BigInt(parsedLog.args.validatorId),
      from: parsedLog.args.from.toLowerCase(),
      amount: BigInt(parsedLog.args.amount)
    };
  }

  private decodeEpochChanged(
    parsedLog: ethers.LogDescription,
    baseEvent: any
  ): EpochChangedEvent {
    const newEpoch = BigInt(parsedLog.args.newEpoch);

    // Update internal epoch tracker
    this.currentEpoch = newEpoch;
    logger.info(`Epoch changed: ${parsedLog.args.oldEpoch} → ${newEpoch}`);

    return {
      ...baseEvent,
      eventType: 'EpochChanged',
      oldEpoch: BigInt(parsedLog.args.oldEpoch),
      newEpoch
    };
  }

  /**
   * Validate event data
   */
  private validateEvent(event: StakingEvent): boolean {
    try {
      // Basic validation
      if (!event.transactionHash || event.transactionHash.length !== 66) {
        logger.warn('Invalid transaction hash', { txHash: event.transactionHash });
        return false;
      }

      if (event.blockNumber <= 0) {
        logger.warn('Invalid block number', { blockNumber: event.blockNumber });
        return false;
      }

      // Event-specific validation
      switch (event.eventType) {
        case 'ValidatorCreated':
        case 'ValidatorStatusChanged':
        case 'Delegate':
        case 'Undelegate':
        case 'Withdraw':
        case 'ClaimRewards':
        case 'CommissionChanged':
        case 'ValidatorRewarded':
          if (event.validatorId <= BigInt(0)) {
            logger.warn('Invalid validator ID', { validatorId: event.validatorId });
            return false;
          }
          break;

        case 'EpochChanged':
          if (event.newEpoch <= event.oldEpoch) {
            logger.warn('Invalid epoch transition', {
              oldEpoch: event.oldEpoch,
              newEpoch: event.newEpoch
            });
            return false;
          }
          break;
      }

      // Validate amounts
      if ('amount' in event && event.amount < BigInt(0)) {
        logger.warn('Invalid amount (negative)', { amount: event.amount });
        return false;
      }

      // Validate addresses
      if ('delegator' in event && event.delegator) {
        if (!ethers.isAddress(event.delegator)) {
          logger.warn('Invalid delegator address', { delegator: event.delegator });
          return false;
        }
      }

      if ('authAddress' in event && event.authAddress) {
        if (!ethers.isAddress(event.authAddress)) {
          logger.warn('Invalid auth address', { authAddress: event.authAddress });
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Event validation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        eventType: event.eventType
      });
      return false;
    }
  }
}
