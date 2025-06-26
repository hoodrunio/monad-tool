// Simple logger utility for monad-explorer
interface Logger {
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, data?: any): void;
  debug(message: string, data?: any): void;
}

class SimpleLogger implements Logger {
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
    console.log(this.formatMessage('INFO', message, data));
  }

  warn(message: string, data?: any): void {
    console.warn(this.formatMessage('WARN', message, data));
  }

  error(message: string, data?: any): void {
    console.error(this.formatMessage('ERROR', message, data));
  }

  debug(message: string, data?: any): void {
    console.debug(this.formatMessage('DEBUG', message, data));
  }
}

export const logger = new SimpleLogger(); 