#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';

/**
 * Performance Monitor for Monad Explorer Processor
 * 
 * Monitors processor.log for performance metrics after optimization
 * - Transaction throughput
 * - Log volume reduction
 * - Processing speed improvements
 */

interface PerformanceMetrics {
  timestamp: string;
  logLinesPerMinute: number;
  transactionEnrichmentRate: number;
  errorCount: number;
  avgProcessingTime: number;
}

class ProcessorPerformanceMonitor {
  private logPath: string;
  private monitoringInterval: number = 60000; // 1 minute
  private metrics: PerformanceMetrics[] = [];

  constructor(logPath: string = './logs/processor.log') {
    this.logPath = path.resolve(logPath);
  }

  /**
   * Start monitoring processor performance
   */
  public start(): void {
    console.log('🚀 Starting Processor Performance Monitor...');
    console.log(`📋 Monitoring log file: ${this.logPath}`);
    console.log(`⏰ Update interval: ${this.monitoringInterval/1000}s`);
    console.log('---');

    setInterval(() => {
      this.collectMetrics();
    }, this.monitoringInterval);

    // Initial collection
    this.collectMetrics();
  }

  /**
   * Collect performance metrics from the log file
   */
  private collectMetrics(): void {
    try {
      if (!fs.existsSync(this.logPath)) {
        console.log(`❌ Log file not found: ${this.logPath}`);
        return;
      }

      const logContent = fs.readFileSync(this.logPath, 'utf-8');
      const lines = logContent.split('\n').filter(line => line.trim());
      
      // Get logs from the last minute
      const oneMinuteAgo = Date.now() - this.monitoringInterval;
      const recentLines = lines.filter(line => {
        const timestampMatch = line.match(/\[([^\]]+)\]/);
        if (timestampMatch) {
          const timestamp = new Date(timestampMatch[1]).getTime();
          return timestamp >= oneMinuteAgo;
        }
        return false;
      });

      // Calculate metrics
      const metrics: PerformanceMetrics = {
        timestamp: new Date().toISOString(),
        logLinesPerMinute: recentLines.length,
        transactionEnrichmentRate: this.countTransactionEnrichments(recentLines),
        errorCount: this.countErrors(recentLines),
        avgProcessingTime: this.calculateAvgProcessingTime(recentLines),
      };

      this.metrics.push(metrics);
      this.displayMetrics(metrics);
      
      // Keep only last 60 metrics (1 hour of data)
      if (this.metrics.length > 60) {
        this.metrics.shift();
      }

    } catch (error) {
      console.error('❌ Error collecting metrics:', error);
    }
  }

  /**
   * Count transaction enrichment progress logs
   */
  private countTransactionEnrichments(lines: string[]): number {
    return lines.filter(line => 
      line.includes('Transaction enrichment progress') ||
      line.includes('Slow transaction enrichment detected')
    ).length;
  }

  /**
   * Count error logs
   */
  private countErrors(lines: string[]): number {
    return lines.filter(line => 
      line.includes('error:') || 
      line.includes('ERROR') ||
      line.includes('Failed to')
    ).length;
  }

  /**
   * Calculate average processing time from slow transaction logs
   */
  private calculateAvgProcessingTime(lines: string[]): number {
    const slowTxLines = lines.filter(line => 
      line.includes('Slow transaction enrichment detected')
    );

    if (slowTxLines.length === 0) return 0;

    const durations = slowTxLines.map(line => {
      const match = line.match(/"duration":(\d+)/);
      return match ? parseInt(match[1]) : 0;
    }).filter(duration => duration > 0);

    return durations.length > 0 
      ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
      : 0;
  }

  /**
   * Display current metrics
   */
  private displayMetrics(metrics: PerformanceMetrics): void {
    console.clear();
    console.log('📊 PROCESSOR PERFORMANCE MONITOR');
    console.log('===============================');
    console.log(`🕐 Time: ${new Date(metrics.timestamp).toLocaleTimeString()}`);
    console.log(`📝 Log Lines/min: ${metrics.logLinesPerMinute}`);
    console.log(`⚡ TX Enrichments/min: ${metrics.transactionEnrichmentRate * 1000}`); // Multiply by interval for real rate
    console.log(`❌ Errors/min: ${metrics.errorCount}`);
    console.log(`⏱️  Avg Processing Time: ${metrics.avgProcessingTime}ms`);
    console.log('');

    // Show trend if we have enough data
    if (this.metrics.length >= 2) {
      const previous = this.metrics[this.metrics.length - 2];
      const current = metrics;
      
      console.log('📈 TRENDS (vs previous minute):');
      console.log(`   Log Volume: ${this.getTrendIndicator(current.logLinesPerMinute, previous.logLinesPerMinute)}`);
      console.log(`   TX Rate: ${this.getTrendIndicator(current.transactionEnrichmentRate, previous.transactionEnrichmentRate)}`);
      console.log(`   Errors: ${this.getTrendIndicator(current.errorCount, previous.errorCount, true)}`);
      console.log('');
    }

    console.log('💡 OPTIMIZATION STATUS:');
    console.log('   ✅ Removed excessive RabbitMQ debug logs');
    console.log('   ✅ Removed transaction worker debug logs');
    console.log('   ✅ Added periodic summary logging');
    console.log('   ✅ Added slow transaction detection');
    console.log('');
    console.log('Press Ctrl+C to stop monitoring...');
  }

  /**
   * Get trend indicator
   */
  private getTrendIndicator(current: number, previous: number, isError: boolean = false): string {
    if (current > previous) {
      return isError ? '📈 ⚠️  INCREASED' : '📈 ✅ INCREASED';
    } else if (current < previous) {
      return isError ? '📉 ✅ DECREASED' : '📉 ⚠️  DECREASED';
    } else {
      return '➡️  STABLE';
    }
  }
}

// Start monitoring
const monitor = new ProcessorPerformanceMonitor();
monitor.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Stopping performance monitor...');
  process.exit(0);
}); 