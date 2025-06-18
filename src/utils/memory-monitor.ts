/**
 * Memory monitoring utility for preventing WebAssembly memory exhaustion
 */
export class MemoryMonitor {
  private static instance: MemoryMonitor;
  private isMonitoring = false;
  private monitoringInterval?: NodeJS.Timeout;
  private memoryThreshold = 0.8; // 80% of available memory
  private cleanupCallbacks: Array<() => Promise<void> | void> = [];
  
  private constructor() {}
  
  static getInstance(): MemoryMonitor {
    if (!MemoryMonitor.instance) {
      MemoryMonitor.instance = new MemoryMonitor();
    }
    return MemoryMonitor.instance;
  }
  
  /**
   * Start memory monitoring
   */
  startMonitoring(intervalMs = 10000): void {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    console.info('🔍 Memory monitoring started');
    
    this.monitoringInterval = setInterval(() => {
      this.checkMemoryUsage();
    }, intervalMs);
  }
  
  /**
   * Stop memory monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    this.isMonitoring = false;
    console.info('🔍 Memory monitoring stopped');
  }
  
  /**
   * Register cleanup callback
   */
  registerCleanupCallback(callback: () => Promise<void> | void): void {
    this.cleanupCallbacks.push(callback);
  }
  
  /**
   * Get current memory usage info
   */
  getMemoryInfo(): {
    used: number;
    total: number;
    percentage: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  } {
    const memoryUsage = process.memoryUsage();
    const totalMemory = require('os').totalmem();
    const freeMemory = require('os').freemem();
    const usedMemory = totalMemory - freeMemory;
    
    return {
      used: usedMemory,
      total: totalMemory,
      percentage: (usedMemory / totalMemory),
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      external: memoryUsage.external,
      arrayBuffers: memoryUsage.arrayBuffers
    };
  }
  
  /**
   * Check memory usage and trigger cleanup if needed
   */
  private async checkMemoryUsage(): Promise<void> {
    const memInfo = this.getMemoryInfo();
    
    // Log memory usage periodically
    if (memInfo.percentage > 0.7) {
      console.warn(`⚠️ High memory usage: ${(memInfo.percentage * 100).toFixed(1)}%`);
      console.warn(`📊 Heap: ${(memInfo.heapUsed / 1024 / 1024).toFixed(1)}MB / ${(memInfo.heapTotal / 1024 / 1024).toFixed(1)}MB`);
      console.warn(`🔗 External: ${(memInfo.external / 1024 / 1024).toFixed(1)}MB`);
    }
    
    // Trigger cleanup if memory usage is high
    if (memInfo.percentage > this.memoryThreshold) {
      console.error('🚨 Memory threshold exceeded, triggering cleanup');
      await this.triggerCleanup();
    }
  }
  
  /**
   * Trigger cleanup callbacks
   */
  private async triggerCleanup(): Promise<void> {
    console.info('🧹 Running memory cleanup...');
    
    for (const callback of this.cleanupCallbacks) {
      try {
        await callback();
      } catch (error) {
        console.error('❌ Cleanup callback failed:', error);
      }
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      console.info('🗑️ Forced garbage collection');
    }
    
    // Log memory after cleanup
    const memInfo = this.getMemoryInfo();
    console.info(`🧹 Memory after cleanup: ${(memInfo.percentage * 100).toFixed(1)}%`);
  }
  
  /**
   * Force immediate cleanup
   */
  async forceCleanup(): Promise<void> {
    await this.triggerCleanup();
  }
  
  /**
   * Check if memory usage is safe for new operations
   */
  isMemorySafe(): boolean {
    const memInfo = this.getMemoryInfo();
    return memInfo.percentage < (this.memoryThreshold - 0.1); // 10% buffer
  }
  
  /**
   * Wait for memory to be safe
   */
  async waitForMemorySafe(timeoutMs = 30000): Promise<boolean> {
    const startTime = Date.now();
    
    while (!this.isMemorySafe()) {
      if (Date.now() - startTime > timeoutMs) {
        console.error('⏰ Timeout waiting for memory to be safe');
        return false;
      }
      
      await this.forceCleanup();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return true;
  }
}

// Export singleton instance
export const memoryMonitor = MemoryMonitor.getInstance(); 