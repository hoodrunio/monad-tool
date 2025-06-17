// Monad Validator Analytics - API Testing Script
import { logger } from '../src/utils/logger';

interface TestResult {
  endpoint: string;
  method: string;
  status: number;
  success: boolean;
  responseTime: number;
  error?: string;
}

class APITester {
  private baseUrl: string;
  private results: TestResult[] = [];

  constructor(baseUrl: string = 'http://localhost:4000') {
    this.baseUrl = baseUrl;
  }

  async testEndpoint(endpoint: string, method: string = 'GET', body?: any): Promise<TestResult> {
    const startTime = Date.now();
    const url = `${this.baseUrl}${endpoint}`;
    
    try {
      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Monad-API-Tester/1.0'
        }
      };

      if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);
      const responseTime = Date.now() - startTime;
      
      const result: TestResult = {
        endpoint,
        method,
        status: response.status,
        success: response.ok,
        responseTime
      };

      if (!response.ok) {
        const errorText = await response.text();
        result.error = errorText;
      }

      this.results.push(result);
      return result;
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const result: TestResult = {
        endpoint,
        method,
        status: 0,
        success: false,
        responseTime,
        error: error instanceof Error ? error.message : String(error)
      };

      this.results.push(result);
      return result;
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🧪 Starting Monad Analytics API Tests...');
    console.log('==========================================\n');

    // Health & System Tests
    console.log('🏥 Testing Health & System Endpoints:');
    await this.testEndpoint('/health');
    await this.testEndpoint('/api/system/health');
    await this.testEndpoint('/api/system/metrics');
    await this.testEndpoint('/api/system/readiness');
    await this.testEndpoint('/api/system/liveness');
    await this.testEndpoint('/api/system/cache');
    await this.testEndpoint('/api/system/tables');
    console.log('');

    // Network Tests
    console.log('🌐 Testing Network Endpoints:');
    await this.testEndpoint('/api/network/summary');
    await this.testEndpoint('/api/network/metrics');
    await this.testEndpoint('/api/network/health-score');
    await this.testEndpoint('/api/network/consensus-efficiency');
    await this.testEndpoint('/api/network/throughput');
    await this.testEndpoint('/api/geographic/distribution');
    console.log('');

    // Validator Tests
    console.log('👥 Testing Validator Endpoints:');
    await this.testEndpoint('/api/validators/rankings');
    await this.testEndpoint('/api/validators/rankings?limit=10&window=1h');
    await this.testEndpoint('/api/validators/rankings?sortBy=success_rate');
    
    // Test with a specific validator (we'll use a placeholder)
    await this.testEndpoint('/api/validators/test-validator');
    await this.testEndpoint('/api/validators/test-validator/history');
    await this.testEndpoint('/api/validators/test-validator/performance');
    console.log('');

    // Event Tests
    console.log('📋 Testing Event Endpoints:');
    await this.testEndpoint('/api/events/recent');
    await this.testEndpoint('/api/events/recent?limit=50');
    await this.testEndpoint('/api/events/types');
    await this.testEndpoint('/api/events/timeline');
    await this.testEndpoint('/api/events/statistics');
    await this.testEndpoint('/api/events/search?query=vote');
    console.log('');

    // Admin Tests (Read-only)
    console.log('🔧 Testing Admin Endpoints (Read-only):');
    await this.testEndpoint('/api/cache/stats');
    await this.testEndpoint('/api/ingestion/status');
    await this.testEndpoint('/api/database/stats');
    await this.testEndpoint('/api/maintenance/status');
    console.log('');

    // API Documentation & Status
    console.log('📚 Testing Documentation Endpoints:');
    await this.testEndpoint('/api/docs');
    await this.testEndpoint('/api/status');
    console.log('');

    // Test some invalid endpoints
    console.log('❌ Testing Error Handling:');
    await this.testEndpoint('/api/nonexistent');
    await this.testEndpoint('/api/validators/rankings?window=invalid');
    console.log('');

    // Display Results
    this.displayResults();
  }

  private displayResults(): void {
    console.log('📊 Test Results Summary:');
    console.log('========================\n');

    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);
    const avgResponseTime = this.results.reduce((sum, r) => sum + r.responseTime, 0) / this.results.length;

    console.log(`✅ Successful: ${successful.length}/${this.results.length}`);
    console.log(`❌ Failed: ${failed.length}/${this.results.length}`);
    console.log(`⚡ Average Response Time: ${avgResponseTime.toFixed(2)}ms\n`);

    // Show successful endpoints
    if (successful.length > 0) {
      console.log('✅ Successful Endpoints:');
      successful.forEach(result => {
        const statusIcon = result.status === 200 ? '🟢' : result.status < 400 ? '🟡' : '🔴';
        console.log(`  ${statusIcon} ${result.method} ${result.endpoint} - ${result.status} (${result.responseTime}ms)`);
      });
      console.log('');
    }

    // Show failed endpoints
    if (failed.length > 0) {
      console.log('❌ Failed Endpoints:');
      failed.forEach(result => {
        console.log(`  🔴 ${result.method} ${result.endpoint} - ${result.status || 'ERROR'} (${result.responseTime}ms)`);
        if (result.error) {
          console.log(`     Error: ${result.error.substring(0, 100)}...`);
        }
      });
      console.log('');
    }

    // Performance analysis
    console.log('⚡ Performance Analysis:');
    const fastEndpoints = this.results.filter(r => r.success && r.responseTime < 100);
    const slowEndpoints = this.results.filter(r => r.success && r.responseTime > 1000);
    
    console.log(`  Fast responses (<100ms): ${fastEndpoints.length}`);
    console.log(`  Slow responses (>1000ms): ${slowEndpoints.length}`);
    
    if (slowEndpoints.length > 0) {
      console.log('  Slow endpoints:');
      slowEndpoints.forEach(result => {
        console.log(`    - ${result.endpoint}: ${result.responseTime}ms`);
      });
    }
    console.log('');

    // Final assessment
    const successRate = (successful.length / this.results.length) * 100;
    console.log('🎯 Final Assessment:');
    console.log(`   Success Rate: ${successRate.toFixed(1)}%`);
    console.log(`   API Health: ${successRate > 90 ? '🟢 Excellent' : successRate > 75 ? '🟡 Good' : '🔴 Needs Attention'}`);
    
    if (avgResponseTime < 100) {
      console.log(`   Performance: 🟢 Excellent (${avgResponseTime.toFixed(2)}ms avg)`);
    } else if (avgResponseTime < 500) {
      console.log(`   Performance: 🟡 Good (${avgResponseTime.toFixed(2)}ms avg)`);
    } else {
      console.log(`   Performance: 🔴 Needs Improvement (${avgResponseTime.toFixed(2)}ms avg)`);
    }
  }

  async testWithSampleData(): Promise<void> {
    console.log('📝 Testing with Sample Data:');
    console.log('============================\n');

    // Test log processing endpoint
    const sampleLogs = [
      '{"timestamp":"2024-01-15T10:00:00Z","level":"INFO","target":"monad_consensus_state","fields":{"msg":"vote attempt","round":1234,"validator":"test-validator-1"}}',
      '{"timestamp":"2024-01-15T10:00:01Z","level":"INFO","target":"monad_consensus_state","fields":{"msg":"vote result","round":1234,"success":true}}'
    ];

    console.log('Testing log processing...');
    const logResult = await this.testEndpoint('/api/logs/process', 'POST', { logLines: sampleLogs });
    
    if (logResult.success) {
      console.log('✅ Log processing successful');
      
      // Wait a moment for processing
      console.log('⏳ Waiting for data processing...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Test data retrieval
      console.log('Testing data retrieval after processing...');
      await this.testEndpoint('/api/events/recent?limit=5');
      await this.testEndpoint('/api/validators/rankings?limit=5');
      
    } else {
      console.log('❌ Log processing failed:', logResult.error);
    }
    console.log('');
  }
}

// Main execution
async function main(): Promise<void> {
  const tester = new APITester();
  
  try {
    // Wait for server to be ready
    console.log('⏳ Waiting for server to be ready...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Test server connectivity
    const healthCheck = await tester.testEndpoint('/health');
    if (!healthCheck.success) {
      console.error('❌ Server is not responding. Please ensure the API server is running.');
      console.error('   Run: npm run api:start');
      process.exit(1);
    }
    
    console.log('✅ Server is responding\n');
    
    // Run comprehensive tests
    await tester.runAllTests();
    
    // Test with sample data (optional)
    if (process.env.TEST_WITH_DATA === 'true') {
      await tester.testWithSampleData();
    }
    
    console.log('🎉 API testing completed!');
    console.log('Visit http://localhost:3000/api/docs for API documentation');
    
  } catch (error) {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  }
}

// Run tests if script is executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { APITester, main }; 