import axios from 'axios';

/**
 * Performance Test Script for Optimized Endpoints
 * 
 * This script demonstrates the performance improvements achieved
 * with the optimization strategy for large-scale blockchain data.
 */

const API_BASE_URL = 'http://localhost:8080/api';

interface PerformanceResult {
  endpoint: string;
  responseTime: number;
  cacheHit: boolean;
  dataSize: number;
  status: number;
}

class PerformanceTestRunner {
  private results: PerformanceResult[] = [];

  async testEndpoint(
    endpoint: string, 
    description: string
  ): Promise<PerformanceResult> {
    console.log(`\n🧪 Testing: ${description}`);
    console.log(`📍 Endpoint: ${endpoint}`);
    
    const startTime = Date.now();
    
    try {
      const response = await axios.get(`${API_BASE_URL}${endpoint}`);
      const responseTime = Date.now() - startTime;
      
      const result: PerformanceResult = {
        endpoint,
        responseTime,
        cacheHit: response.headers['cache-hit'] === 'true',
        dataSize: JSON.stringify(response.data).length,
        status: response.status
      };

      console.log(`✅ Success: ${responseTime}ms`);
      console.log(`📊 Data size: ${(result.dataSize / 1024).toFixed(2)} KB`);
      console.log(`🎯 Cache hit: ${result.cacheHit ? 'Yes' : 'No'}`);
      
      this.results.push(result);
      return result;

    } catch (error) {
      console.log(`❌ Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  async runPerformanceComparison(): Promise<void> {
    console.log('🚀 Starting Performance Comparison Tests');
    console.log('=' .repeat(60));

    try {
      // Test optimized block endpoints
      await this.testBlockEndpoints();
      
      // Test optimized transaction endpoints
      await this.testTransactionEndpoints();
      
      // Test address endpoints
      await this.testAddressEndpoints();
      
      // Display summary
      this.displaySummary();

    } catch (error) {
      console.error('Test failed:', error);
    }
  }

  private async testBlockEndpoints(): Promise<void> {
    console.log('\n📦 BLOCK ENDPOINTS PERFORMANCE TEST');
    console.log('-'.repeat(40));

    // Test optimized blocks endpoint
    await this.testEndpoint(
      '/blocks/optimized?limit=20',
      'Latest blocks (optimized with materialized view)'
    );

    // Test block statistics
    await this.testEndpoint(
      '/blocks/optimized/stats',
      'Block statistics (pre-computed aggregations)'
    );

    // Test specific block
    await this.testEndpoint(
      '/blocks/optimized/12345',
      'Single block with transaction count'
    );

    // Test block range
    await this.testEndpoint(
      '/blocks/optimized/range?start=12340&end=12350&limit=10',
      'Block range query'
    );

    // Test block transactions preview
    await this.testEndpoint(
      '/blocks/optimized/12345/transactions/preview?limit=20',
      'Block transactions preview (minimal fields)'
    );
  }

  private async testTransactionEndpoints(): Promise<void> {
    console.log('\n💳 TRANSACTION ENDPOINTS PERFORMANCE TEST');
    console.log('-'.repeat(40));

    // Test optimized transactions endpoint
    await this.testEndpoint(
      '/transactions/optimized?limit=20',
      'Latest transactions (materialized view)'
    );

    // Test transaction statistics
    await this.testEndpoint(
      '/transactions/optimized/stats',
      'Transaction statistics (aggregated data)'
    );

    // Test cursor-based pagination
    await this.testEndpoint(
      '/transactions/optimized?limit=20&cursor=2024-01-01T00:00:00Z',
      'Cursor-based pagination (efficient for large datasets)'
    );

    // Test transaction search
    await this.testEndpoint(
      '/transactions/optimized/search?fromAddress=0x1234567890123456789012345678901234567890&limit=10',
      'Transaction search with filters'
    );
  }

  private async testAddressEndpoints(): Promise<void> {
    console.log('\n👤 ADDRESS ENDPOINTS PERFORMANCE TEST');
    console.log('-'.repeat(40));

    const testAddress = '0x1234567890123456789012345678901234567890';

    // Test optimized address transactions
    await this.testEndpoint(
      `/addresses/optimized/${testAddress}/transactions?limit=20`,
      'Address transaction history (with pre-computed stats)'
    );

    // Test address transactions by type
    await this.testEndpoint(
      `/addresses/optimized/${testAddress}/transactions?type=sent&limit=20`,
      'Address sent transactions only'
    );

    // Test with cursor pagination
    await this.testEndpoint(
      `/addresses/optimized/${testAddress}/transactions?limit=20&cursor=2024-01-01T00:00:00Z`,
      'Address transactions with cursor pagination'
    );
  }

  private displaySummary(): void {
    console.log('\n📈 PERFORMANCE SUMMARY');
    console.log('='.repeat(60));

    const avgResponseTime = this.results.reduce((sum, r) => sum + r.responseTime, 0) / this.results.length;
    const cacheHitRate = this.results.filter(r => r.cacheHit).length / this.results.length * 100;
    const totalDataTransferred = this.results.reduce((sum, r) => sum + r.dataSize, 0);

    console.log(`📊 Total endpoints tested: ${this.results.length}`);
    console.log(`⚡ Average response time: ${avgResponseTime.toFixed(0)}ms`);
    console.log(`🎯 Cache hit rate: ${cacheHitRate.toFixed(1)}%`);
    console.log(`📦 Total data transferred: ${(totalDataTransferred / 1024 / 1024).toFixed(2)} MB`);

    // Performance categories
    const fastEndpoints = this.results.filter(r => r.responseTime < 200);
    const mediumEndpoints = this.results.filter(r => r.responseTime >= 200 && r.responseTime < 500);
    const slowEndpoints = this.results.filter(r => r.responseTime >= 500);

    console.log('\n🚦 Response Time Distribution:');
    console.log(`🟢 Fast (< 200ms): ${fastEndpoints.length} endpoints`);
    console.log(`🟡 Medium (200-500ms): ${mediumEndpoints.length} endpoints`);
    console.log(`🔴 Slow (> 500ms): ${slowEndpoints.length} endpoints`);

    // Detailed results table
    console.log('\n📋 DETAILED RESULTS');
    console.log('-'.repeat(80));
    console.log('Endpoint'.padEnd(40) + 'Time'.padEnd(10) + 'Cache'.padEnd(10) + 'Size'.padEnd(10));
    console.log('-'.repeat(80));

    this.results.forEach(result => {
      const endpoint = result.endpoint.slice(0, 37) + (result.endpoint.length > 37 ? '...' : '');
      const time = `${result.responseTime}ms`;
      const cache = result.cacheHit ? 'HIT' : 'MISS';
      const size = `${(result.dataSize / 1024).toFixed(1)}KB`;
      
      console.log(
        endpoint.padEnd(40) + 
        time.padEnd(10) + 
        cache.padEnd(10) + 
        size.padEnd(10)
      );
    });

    // Performance insights
    console.log('\n💡 PERFORMANCE INSIGHTS');
    console.log('-'.repeat(40));
    
    if (avgResponseTime < 500) {
      console.log('✅ Excellent performance! API responses are fast.');
    } else {
      console.log('⚠️  Consider further optimization for better performance.');
    }

    if (cacheHitRate > 70) {
      console.log('✅ Good cache utilization! Reducing database load.');
    } else {
      console.log('📝 Consider increasing cache TTL or pre-warming cache.');
    }

    if (slowEndpoints.length === 0) {
      console.log('✅ No slow endpoints detected! All responses are optimal.');
    } else {
      console.log(`⚠️  ${slowEndpoints.length} endpoints need optimization.`);
    }
  }
}

// Utility function to test database aggregation status
async function checkAggregationStatus(): Promise<void> {
  console.log('\n🗃️  CHECKING AGGREGATION STATUS');
  console.log('-'.repeat(40));

  try {
    const response = await axios.get(`${API_BASE_URL}/admin/aggregation-stats`);
    const stats = response.data;

    console.log(`📊 Block stats: ${stats.blockStatsCount} records`);
    console.log(`👤 Address stats: ${stats.addressStatsCount} records`);
    console.log(`📅 Daily stats: ${stats.dailyStatsCount} records`);
    console.log(`🔢 Last processed block: ${stats.lastProcessedBlock}`);

    if (stats.blockStatsCount === 0) {
      console.log('⚠️  No aggregation data found. Run backfill process first.');
    } else {
      console.log('✅ Aggregation data is available.');
    }

  } catch (error) {
    console.log('ℹ️  Aggregation status endpoint not available.');
  }
}

// Run the performance tests
async function main(): Promise<void> {
  console.log('🎯 MONAD EXPLORER PERFORMANCE TEST SUITE');
  console.log('Testing optimized endpoints for large-scale blockchain data');
  console.log('='.repeat(60));

  const testRunner = new PerformanceTestRunner();
  
  // Check aggregation status first
  await checkAggregationStatus();
  
  // Run performance comparison
  await testRunner.runPerformanceComparison();

  console.log('\n🎉 Performance testing completed!');
  console.log('\n📚 For optimization details, see: PERFORMANCE_OPTIMIZATION_GUIDE.md');
}

// Execute if run directly
if (require.main === module) {
  main().catch(console.error);
}

export { PerformanceTestRunner, checkAggregationStatus }; 