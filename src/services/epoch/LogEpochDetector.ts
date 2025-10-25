/**
 * Log-Based Epoch Detector
 *
 * Detects the current epoch by parsing live consensus logs.
 * This is the most reliable source during chain halts or restarts.
 *
 * Sources:
 * - Production: journalctl -u monad-bft
 * - Development: examples/monad-bft.log
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import { logger } from '../../utils/logger';
import dotenv from 'dotenv';
dotenv.config();

export interface LogEpochDetectorConfig {
  serviceName?: string;
  logFilePath?: string;
  linesToCheck?: number;
}

export class LogEpochDetector {
  private serviceName: string;
  private logFilePath: string;
  private linesToCheck: number;

  constructor(config?: LogEpochDetectorConfig) {
    this.serviceName = config?.serviceName || process.env.MONAD_BFT_SERVICE_NAME || 'monad-bft';
    this.logFilePath = config?.logFilePath || process.env.MONAD_BFT_LOG_PATH || './examples/monad-bft.log';
    this.linesToCheck = config?.linesToCheck || 100;
  }

  /**
   * Detect current epoch from live logs
   * Returns null if epoch cannot be detected
   */
  async detectEpoch(): Promise<number | null> {
    const isProduction = process.env.NODE_ENV === 'production';

    try {
      if (isProduction) {
        logger.info('🔍 Detecting epoch from systemd logs...');
        return await this.detectFromSystemd();
      } else {
        logger.info(`🔍 Detecting epoch from log file: ${this.logFilePath}`);
        return await this.detectFromFile();
      }
    } catch (error) {
      logger.warn('Failed to detect epoch from logs:', error);
      return null;
    }
  }

  /**
   * Detect epoch from systemd journalctl output (production)
   */
  private async detectFromSystemd(): Promise<number | null> {
    return new Promise((resolve) => {
      const journalctl = spawn('journalctl', [
        '-u', this.serviceName,
        '-n', String(this.linesToCheck),
        '-o', 'cat',
        '--no-pager'
      ]);

      let output = '';
      let errorOutput = '';

      journalctl.stdout.on('data', (data) => {
        output += data.toString();
      });

      journalctl.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      journalctl.on('close', (code) => {
        if (code !== 0) {
          logger.warn(`journalctl exited with code ${code}: ${errorOutput}`);
          resolve(null);
          return;
        }

        const epoch = this.parseEpochFromOutput(output);
        if (epoch !== null) {
          logger.info(`✅ Detected epoch ${epoch} from systemd logs`);
        }
        resolve(epoch);
      });

      journalctl.on('error', (error) => {
        logger.warn('journalctl spawn error:', error);
        resolve(null);
      });
    });
  }

  /**
   * Detect epoch from log file (development)
   */
  private async detectFromFile(): Promise<number | null> {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        logger.warn(`Log file not found: ${this.logFilePath}`);
        return null;
      }

      const content = fs.readFileSync(this.logFilePath, 'utf-8');
      const epoch = this.parseEpochFromOutput(content);

      if (epoch !== null) {
        logger.info(`✅ Detected epoch ${epoch} from log file`);
      }

      return epoch;
    } catch (error) {
      logger.warn(`Failed to read log file ${this.logFilePath}:`, error);
      return null;
    }
  }

  /**
   * Parse epoch from log output using multiple patterns
   */
  private parseEpochFromOutput(output: string): number | null {
    // Take only first N lines for performance
    const lines = output.split('\n').slice(0, this.linesToCheck);

    for (const line of lines) {
      const epoch = this.parseEpochFromLine(line);
      if (epoch !== null) {
        return epoch;
      }
    }

    return null;
  }

  /**
   * Parse epoch from a single log line
   * Supports multiple log formats:
   * - JSON: "epoch":"619" or "epoch":619
   * - Text: epoch: 619, epoch = 619
   */
  private parseEpochFromLine(line: string): number | null {
    // Pattern 1: JSON format - "epoch":"619" or "epoch":619
    const jsonMatch = line.match(/"epoch"\s*:\s*"?(\d+)"?/);
    if (jsonMatch) {
      return Number(jsonMatch[1]);
    }

    // Pattern 2: Text format - epoch: 619, epoch = 619
    const textMatch = line.match(/\bepoch\s*[=:]\s*(\d+)/i);
    if (textMatch) {
      return Number(textMatch[1]);
    }

    // Pattern 3: Inside structured data - { ... epoch: 619, ... }
    const structMatch = line.match(/\{\s*[^}]*epoch\s*:\s*(\d+)/i);
    if (structMatch) {
      return Number(structMatch[1]);
    }

    return null;
  }
}
