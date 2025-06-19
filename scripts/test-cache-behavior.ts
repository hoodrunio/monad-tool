#!/usr/bin/env tsx

import { ValidatorInfoService } from '../src/services/validator-info-service';
import { validatorRegistry } from '../src/services/validator-registry';

async function testCacheBehavior() {
  console.log('🧪 Testing DNS Cache Behavior - Restart Optimization');
  console.log('=' .repeat(60));

  try {
    // Initialize services
    const validatorInfoService = new ValidatorInfoService();
    
    console.log('1️⃣ Initializing services...');
    await validatorInfoService.initialize();
    
    console.log('\n2️⃣ Initial cache status:');
    const initialStatus = validatorInfoService.getCacheStatus();
    console.log(`   📊 Total cached: ${initialStatus.totalCached}`);
    console.log(`   ✅ Valid entries: ${initialStatus.validEntries}`);
    console.log(`   ❌ Expired entries: ${initialStatus.expiredEntries}`);
    console.log(`   🌐 Entries with DNS: ${initialStatus.entriesWithDns}`);
    console.log(`   📅 Average age: ${initialStatus.avgAge} hours`);
    
    console.log('\n3️⃣ Checking DNS processing decision...');
    const shouldSkip = validatorInfoService.shouldSkipDnsProcessing();
    
    console.log('\n4️⃣ Running preProcessAll (this should be fast if cache is working)...');
    const startTime = Date.now();
    await validatorInfoService.preProcessAll();
    const processingTime = Date.now() - startTime;
    
    console.log(`   ⏱️  Processing completed in ${processingTime}ms`);
    
    console.log('\n5️⃣ Final cache status:');
    const finalStatus = validatorInfoService.getCacheStatus();
    console.log(`   📊 Total cached: ${finalStatus.totalCached}`);
    console.log(`   ✅ Valid entries: ${finalStatus.validEntries}`);
    console.log(`   🌐 Entries with DNS: ${finalStatus.entriesWithDns}`);
    
    console.log('\n6️⃣ Service statistics:');
    const stats = validatorInfoService.getStats();
    console.log(`   📈 DNS Coverage: ${stats.dnsCoverage.toFixed(1)}%`);
    console.log(`   🎯 Cache Hit Rate: ${stats.cacheStats.hitRate.toFixed(1)}%`);
    console.log(`   🔄 DNS Processed: ${stats.dnsStats.processedMappings}/${stats.dnsStats.totalMappings}`);
    
    console.log('\n7️⃣ Testing a few validator lookups...');
    const allValidators = validatorRegistry.getAllValidators();
    const sampleValidators = allValidators.slice(0, 3);
    
    for (const validator of sampleValidators) {
      const info = await validatorInfoService.getValidatorInfo(validator.node_id);
      console.log(`   🔍 ${validator.node_id.substring(0, 8)}: ${info?.provider || 'unknown'} - ${info?.location || 'unknown'}`);
    }
    
    // Performance analysis
    console.log('\n📊 Performance Analysis:');
    if (processingTime < 5000) {
      console.log('   ✅ EXCELLENT: Processing completed quickly (<5s) - cache is working well!');
    } else if (processingTime < 15000) {
      console.log('   ⚠️  GOOD: Processing took some time (<15s) - partial cache hit');
    } else {
      console.log('   ❌ SLOW: Processing took long time (>15s) - cache may not be working');
    }
    
    // Cache effectiveness analysis
    const cacheEffectiveness = (finalStatus.validEntries / stats.totalValidators) * 100;
    if (cacheEffectiveness > 90) {
      console.log('   ✅ EXCELLENT: Cache coverage >90% - DNS reprocessing should be minimal');
    } else if (cacheEffectiveness > 70) {
      console.log('   ⚠️  GOOD: Cache coverage >70% - some DNS reprocessing may occur');
    } else {
      console.log('   ❌ POOR: Cache coverage <70% - significant DNS reprocessing likely');
    }
    
    console.log('\n✅ Test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testCacheBehavior().catch(console.error); 