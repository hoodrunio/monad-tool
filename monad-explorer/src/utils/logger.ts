import winston from 'winston';

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

class WinstonLogger implements Logger {
  private winstonLogger: winston.Logger;
  private logLevel: LogLevel;

  constructor() {
    // Get log level from environment variable, default to INFO
    const envLogLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
    this.logLevel = LogLevel[envLogLevel as keyof typeof LogLevel] ?? LogLevel.INFO;

    // Map our log levels to Winston levels
    const winstonLevel = this.getWinstonLevel(this.logLevel);

    this.winstonLogger = winston.createLogger({
      level: winstonLevel,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.colorize({ all: true }),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
          let logMessage = `[${timestamp}] ${level}: ${message}`;
          
          // Handle additional data
          if (Object.keys(meta).length > 0) {
            logMessage += ` ${JSON.stringify(meta)}`;
          }
          
          // Handle stack traces for errors
          if (stack) {
            logMessage += `\n${stack}`;
          }
          
          return logMessage;
        })
      ),
      transports: [
        new winston.transports.Console({
          handleExceptions: true,
          handleRejections: true
        })
      ],
      exitOnError: false
    });
  }

  private getWinstonLevel(level: LogLevel): string {
    switch (level) {
      case LogLevel.ERROR:
        return 'error';
      case LogLevel.WARN:
        return 'warn';
      case LogLevel.INFO:
        return 'info';
      case LogLevel.DEBUG:
        return 'debug';
      default:
        return 'info';
    }
  }

  private formatData(data: any): object {
    if (data === undefined || data === null) {
      return {};
    }
    
    if (typeof data === 'object') {
      return data;
    }
    
    return { data };
  }

  info(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.INFO) {
      this.winstonLogger.info(message, this.formatData(data));
    }
  }

  warn(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.WARN) {
      this.winstonLogger.warn(message, this.formatData(data));
    }
  }

  error(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.ERROR) {
      this.winstonLogger.error(message, this.formatData(data));
    }
  }

  debug(message: string, data?: any): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      this.winstonLogger.debug(message, this.formatData(data));
    }
  }
}

export const logger = new WinstonLogger();