import { EventType, EventTypeMapping } from './types';

export class LogProcessor {
  constructor() {}

  parseLog(logLine: string): any {
    try {
      const log = JSON.parse(logLine);
      return this.processLogEntry(log);
    } catch (error) {
      console.error('Failed to parse log:', error);
      return null;
    }
  }

  private processLogEntry(log: any): any {
    const fields = log.fields;
    const message = fields?.message;
    
    if (!message || !EventTypeMapping[message]) {
      return null;
    }

    const timestamp = new Date(log.timestamp);
    const eventType = EventTypeMapping[message];

    return {
      timestamp,
      eventType,
      validatorId: fields.author || 'unknown',
      roundNumber: parseInt(fields.round) || 0,
      epochNumber: parseInt(fields.epoch) || 1,
      raw: fields
    };
  }
} 