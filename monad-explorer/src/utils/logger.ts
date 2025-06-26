// Simple logger utility for monad-explorer
interface Logger {
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, data?: any): void;
  debug(message: string, data?: any): void;
}

// Log levels with numeric values for comparison
enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

class SimpleLogger implements Logger {
  private logLevel: LogLevel;

  constructor() {
    // Get log level from environment variable, default to INFO
    const envLogLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
    this.logLevel = LogLevel[envLogLevel as keyof typeof LogLevel] ?? LogLevel.INFO;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const baseMessage = `[${timestamp}] ${level}: ${message}`;
    
    if (data) {
      if (typeof data === 'object') {
        return `${baseMessage} ${JSON.stringify(data)}`;
      }
      return `${baseMessage} ${data}`;
    }
    
    return baseMessage;
  }

  info(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      console.log(this.formatMessage('INFO', message, data));
    }
  }

  warn(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(this.formatMessage('WARN', message, data));
    }
  }

  error(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(this.formatMessage('ERROR', message, data));
    }
  }

  debug(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      console.debug(this.formatMessage('DEBUG', message, data));
    }
  }
}

export const logger = new SimpleLogger();