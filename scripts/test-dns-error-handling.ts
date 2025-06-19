#!/usr/bin/env ts-node

// Test script to verify DNS error handling improvements
import { DNSMapperService } from '../src/services/dns-mapper';
import { ValidatorInfoService } from '../src/services/validator-info-service';

async function testDNSErrorHandling() {
  console.log('🧪 Testing DNS Error Handling Improvements');
  console.log('==========================================\n');

  try {
    // Initialize services
    console.log('1. Initializing services...');
    const dnsMapper = new DNSMapperService();
    const validatorInfoService = new ValidatorInfoService();
    
    await dnsMapper.initialize();
    await validatorInfoService.initialize();
    
    console.log('✅ Services initialized successfully\n');

    // Test 1: Process a few validators (including ones that might fail)
    console.log('2. Testing batch processing with error handling...');
    
    const allMappings = dnsMapper.getAllDNSMappings();
    const testValidators = allMappings.slice(0, 5); // Test first 5 validators
    
    console.log(`Testing ${testValidators.length} validators:`);
    testValidators.forEach(v => console.log(`  - ${v.nodeId}: ${v.dnsAddress}`));
    console.log();

    const nodeIds = testValidators.map(v => v.nodeId);
    const results = await dnsMapper.batchProcessValidatorDNS(nodeIds);
    
    console.log(`✅ Batch processing completed: ${results.length}/${nodeIds.length} processed successfully\n`);

    // Test 2: Test ValidatorInfoService with potential DNS failures
    console.log('3. Testing ValidatorInfoService error resilience...');
    
    const validatorInfoMap = await validatorInfoService.batchGetValidatorInfo(nodeIds);
    
    console.log(`✅ ValidatorInfoService processed: ${validatorInfoMap.size}/${nodeIds.length} validators\n`);

    // Test 3: Show statistics
    console.log('4. DNS Mapper Statistics:');
    const dnsStats = dnsMapper.getStats();
    console.log(`  - Total mappings: ${dnsStats.totalMappings}`);
    console.log(`  - Processed mappings: ${dnsStats.processedMappings}`);
    console.log(`  - Error count: ${dnsStats.errorCount}`);
    console.log(`  - Cache hit rate: ${dnsStats.cacheHitRate.toFixed(1)}%\n`);

    console.log('5. Validator Info Service Statistics:');
    const infoStats = validatorInfoService.getStats();
    console.log(`  - Total validators: ${infoStats.totalValidators}`);
    console.log(`  - Validators with DNS: ${infoStats.validatorsWithDNS}`);
    console.log(`  - DNS coverage: ${infoStats.dnsCoverage.toFixed(1)}%`);
    console.log(`  - DNS errors: ${infoStats.dnsStats.errorCount}\n`);

    // Test 4: Show sample of processed validators
    console.log('6. Sample processed validator info:');
    let sampleCount = 0;
    for (const [nodeId, info] of validatorInfoMap) {
      if (sampleCount >= 3) break;
      console.log(`  Validator ${nodeId}:`);
      console.log(`    - Stake: ${info.stake}`);
      console.log(`    - DNS: ${info.dnsAddress || 'N/A'}`);
      console.log(`    - Provider: ${info.provider}`);
      console.log(`    - Location: ${info.location}`);
      console.log(`    - Active: ${info.isActive}`);
      console.log();
      sampleCount++;
    }

    console.log('🎉 DNS Error Handling Test Completed Successfully!');
    console.log('All services gracefully handled DNS failures without crashing.');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testDNSErrorHandling()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  }); 