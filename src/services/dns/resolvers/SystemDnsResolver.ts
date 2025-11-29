import { execSync } from 'child_process';
import { IDnsResolver } from '../interfaces/IDnsResolver';
import { DnsResolverResponse } from '../types';

export class SystemDnsResolver implements IDnsResolver {
  private readonly timeout: number;
  private readonly retries: number;
  
  // Statistics tracking
  private resolutionsMade = 0;
  private failures = 0;
  private timeouts = 0;
  private totalResponseTime = 0;
  
  constructor(timeout: number = 5000, retries: number = 2) {
    this.timeout = timeout;
    this.retries = retries;
  }
  
  async resolve(hostname: string): Promise<DnsResolverResponse> {
    const startTime = Date.now();
    
    try {
      const ip = await this.performResolution(hostname);
      const responseTime = Date.now() - startTime;
      
      this.resolutionsMade++;
      this.totalResponseTime += responseTime;
      
      return {
        success: true,
        ip
      };
      
    } catch (error) {
      this.failures++;
      
      const isTimeout = error instanceof Error && error.message.includes('timeout');
      if (isTimeout) {
        this.timeouts++;
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown DNS resolution error',
        timeout: isTimeout
      };
    }
  }
  
  private async performResolution(hostname: string): Promise<string> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.resolveWithNslookup(hostname);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        
        if (attempt < this.retries) {
          // Wait before retry with exponential backoff
          await this.delay(Math.pow(2, attempt) * 1000);
        }
      }
    }
    
    throw lastError;
  }
  
  private async resolveWithNslookup(hostname: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('DNS resolution timeout'));
      }, this.timeout);
      
      try {
        const output = execSync(`nslookup ${hostname}`, { 
          encoding: 'utf8',
          timeout: this.timeout
        });
        
        clearTimeout(timeoutId);
        
        // Parse nslookup output to extract IP
        const ipMatch = output.match(/Address: (\d+\.\d+\.\d+\.\d+)/);
        if (ipMatch && ipMatch[1]) {
          resolve(ipMatch[1]);
        } else {
          reject(new Error('No IP address found in DNS response'));
        }
        
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }
  
  getStats(): {
    resolutionsMade: number;
    failures: number;
    timeouts: number;
    avgResponseTime: number;
  } {
    return {
      resolutionsMade: this.resolutionsMade,
      failures: this.failures,
      timeouts: this.timeouts,
      avgResponseTime: this.resolutionsMade > 0 ? this.totalResponseTime / this.resolutionsMade : 0
    };
  }
  
  resetStats(): void {
    this.resolutionsMade = 0;
    this.failures = 0;
    this.timeouts = 0;
    this.totalResponseTime = 0;
  }
  
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
} 