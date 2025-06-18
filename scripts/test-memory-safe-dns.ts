#!/usr/bin/env ts-node
import { IntelligentDNSParser } from '../src/utils/dns-parser';
import { EnhancedDNSProcessor } from '../src/utils/enhanced-dns-processor';
import { memoryMonitor } from '../src/utils/memory-monitor';

/**
 * Test the memory-safe DNS processing implementation
 */
async function testMemorySafeDNS() {
  console.log('🧪 Testing Memory-Safe DNS Processing');
  console.log('====================================');
  
  // Start memory monitoring
  memoryMonitor.startMonitoring(5000); // Check every 5 seconds
  
  // Test DNS addresses (some real, some fake)
  const testDNSAddresses = [
    'mf-testnet-2-val-tsw-pit-004.monadinfra.com:8000',
    'mf-testnet-2-val-tsw-fra-002.monadinfra.com:8000',
    'bue-004.devcore4.com:8000',
    'monad.testnet.lux8.net:8000',
    'asia-validator.azure.com:8000',
    'backup-val.vultr.com:8000',
    'primary.monadnet.org:8000',
    'failover.testnet.com:8000'
  ];
  
  console.log(`📊 Memory before testing: ${formatMemoryInfo()}`);
  
  // Test individual DNS parser with circuit breaker
  console.log('\n🔍 Testing IntelligentDNSParser with Circuit Breaker');
  const parser = new IntelligentDNSParser();
  
  for (const dns of testDNSAddresses.slice(0, 5)) {
    console.log(`\n📍 Processing: ${dns}`);
    
    try {
      const startTime = Date.now();
      const result = await parser.parse(dns);
      const duration = Date.now() - startTime;
      
      console.log(`✅ Parsed in ${duration}ms:`);
      console.log(`   Provider: ${result.provider}`);
      console.log(`   Network: ${result.network}`);
      console.log(`   Location: ${result.locationInfo?.country || 'unknown'}, ${result.locationInfo?.city || 'unknown'}`);
      console.log(`   ISP: ${result.locationInfo?.isp || 'unknown'}`);
      
    } catch (error) {
      console.log(`❌ Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    // Small delay
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`\n📊 Memory after individual tests: ${formatMemoryInfo()}`);
  
  // Test batch processing with enhanced processor
  console.log('\n🔍 Testing Enhanced DNS Processor Batch Processing');
  const processor = new EnhancedDNSProcessor();
  
  const validators = testDNSAddresses.map((dns, index) => ({
    dnsAddress: dns,
    validatorId: `validator_${index}`
  }));
  
  try {
    const startTime = Date.now();
    const results = await processor.processBatchValidatorDNS(validators);
    const duration = Date.now() - startTime;
    
    console.log(`\n✅ Batch processed in ${duration}ms:`);
    console.log(`   Processed: ${results.length}/${validators.length} validators`);
    
    // Show summary by provider
    const providerCounts = new Map<string, number>();
    results.forEach(result => {
      const count = providerCounts.get(result.provider) || 0;
      providerCounts.set(result.provider, count + 1);
    });
    
    console.log('\n📈 Provider Distribution:');
    providerCounts.forEach((count, provider) => {
      console.log(`   ${provider}: ${count} validators`);
    });
    
  } catch (error) {
    console.log(`❌ Batch processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  console.log(`\n📊 Memory after batch tests: ${formatMemoryInfo()}`);
  
  // Test memory safety features
  console.log('\n🛡️ Testing Memory Safety Features');
  
  console.log(`Memory safe: ${memoryMonitor.isMemorySafe()}`);
  
  // Force cleanup
  console.log('🧹 Testing forced cleanup...');
  await memoryMonitor.forceCleanup();
  
  console.log(`📊 Memory after cleanup: ${formatMemoryInfo()}`);
  
  // Stop monitoring
  memoryMonitor.stopMonitoring();
  
  console.log('\n✅ Memory-safe DNS testing completed!');
}

function formatMemoryInfo(): string {
  const memInfo = memoryMonitor.getMemoryInfo();
  return `${(memInfo.percentage * 100).toFixed(1)}% (${(memInfo.heapUsed / 1024 / 1024).toFixed(1)}MB heap)`;
}

// Run the test
if (require.main === module) {
  testMemorySafeDNS().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
} 