import { TokenType } from '../../model';

export interface LogEvent {
  address: string;
  topics: string[];
  data: string;
}

export interface TokenDetectionFromEvent {
  tokenType: TokenType;
  confidence: number;
  detectionMethod: 'event_signature' | 'event_structure';
}

export interface IEventTokenDetector {
  /**
   * Detect token type from event log
   * Returns null if not a token transfer event
   */
  detectFromTransferEvent(log: LogEvent): TokenDetectionFromEvent | null;
  
  /**
   * Check if log is a token transfer event
   */
  isTransferEvent(log: LogEvent): boolean;
  
  /**
   * Get supported event signatures
   */
  getSupportedSignatures(): string[];
} 