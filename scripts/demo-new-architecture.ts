#!/usr/bin/env npx ts-node

/**
 * Demo: New Separated Validator Services Architecture
 * 
 * This script demonstrates the new single responsibility principle architecture:
 * - ValidatorRegistry: Only handles epochs/stakes from validators.toml
 * - DNSMapper: Only handles DNS resolution from node.toml  
 * - ValidatorInfoService: Combines both for processors
 * - Log processors: Only process events, no DNS lookups
 */

import 'dotenv/config';
import { ValidatorRegistry } from '../src/services/validator-registry';
import { DNSMapperService } from '../src/services/dns-mapper';
import { ValidatorInfoService } from '../src/services/validator-info-service';
import { MonadLogProcessor } from '../src/log-processor/enhanced-processor';
import { ProcessingConfig } from '../src/log-processor/types';

async function demonstrateNewArchitecture() {
  console.log('🏗️  Demonstrating New Separated Validator Services Architecture\n');

  // =============================================
  // 1. VALIDATOR REGISTRY (Epochs/Stakes Only)
  // =============================================
  
  console.log('📊 1. Validator Registry (Epochs/Stakes from validators.toml)');
  console.log('   Single responsibility: Manage validator epochs and stakes');
  
  const validatorRegistry = new ValidatorRegistry();
  await validatorRegistry.initialize();
  
  const stats = validatorRegistry.getValidatorStats();
  console.log(`   ✅ Loaded ${stats.totalValidators} validators from ${validatorRegistry.getAvailableEpochs().length} epochs`);
  console.log(`   📈 Total stake: ${stats.totalStake}, Average: ${stats.averageStake.toFixed(2)}`);
  
  // Test epoch resolution
  validatorRegistry.setCurrentEpoch(5);
  const validator = validatorRegistry.getValidatorByPosition(0);
  if (validator) {
    console.log(`   🔍 Validator at position 0: ${validator.node_id.substring(0, 12)}... (stake: ${validator.stake})`);
  }
  
  console.log('');

  // =============================================
  // 2. DNS MAPPER (DNS Resolution Only)
  // =============================================
  
  console.log('🌐 2. DNS Mapper (DNS Resolution from node.toml)');
  console.log('   Single responsibility: DNS resolution and geolocation');
  
  const dnsMapper = new DNSMapperService();
  await dnsMapper.initialize();
  
  const dnsStats = dnsMapper.getStats();
  console.log(`   ✅ Loaded ${dnsStats.totalMappings} DNS mappings`);
  
  // Test DNS mapping
  const allMappings = dnsMapper.getAllDNSMappings();
  if (allMappings.length > 0) {
    const sampleMapping = allMappings[0];
    console.log(`   🔍 Sample mapping: ${sampleMapping.nodeId.substring(0, 12)}... -> ${sampleMapping.dnsHost}`);
    
    // Get enriched DNS info
    const enrichedInfo = await dnsMapper.getValidatorDNSInfo(sampleMapping.nodeId);
    if (enrichedInfo) {
      console.log(`   🌍 Enriched: ${enrichedInfo.provider} in ${enrichedInfo.location}`);
    }
  }
  
  console.log('');

  // =============================================
  // 3. VALIDATOR INFO SERVICE (Combined)
  // =============================================
  
  console.log('🔧 3. Validator Info Service (Combines Both Services)');
  console.log('   Single responsibility: Provide complete validator info');
  
  const validatorInfoService = new ValidatorInfoService(validatorRegistry, dnsMapper);
  await validatorInfoService.initialize();
  
  // Pre-process all validator information
  console.log('   🔄 Pre-processing all validator DNS information...');
  await validatorInfoService.preProcessAll();
  
  const combinedStats = validatorInfoService.getStats();
  console.log(`   ✅ Combined info for ${combinedStats.totalValidators} validators`);
  console.log(`   📡 DNS coverage: ${combinedStats.dnsCoverage.toFixed(1)}% (${combinedStats.validatorsWithDNS} validators)`);
  console.log(`   💾 Cache: ${combinedStats.cacheStats.totalCached} entries, ${combinedStats.cacheStats.hitRate.toFixed(1)}% hit rate`);
  
  // Test combined lookup
  if (validator) {
    const completeInfo = await validatorInfoService.getValidatorInfo(validator.node_id);
    if (completeInfo) {
      console.log(`   🔍 Complete info for ${completeInfo.nodeId.substring(0, 12)}...:`);
      console.log(`       Stake: ${completeInfo.stake}, Position: ${completeInfo.position}`);
      console.log(`       DNS: ${completeInfo.dnsHost || 'N/A'}`);
      console.log(`       Location: ${completeInfo.location || 'Unknown'}`);
      console.log(`       Provider: ${completeInfo.provider || 'Unknown'}`);
    }
  }
  
  console.log('');

  // =============================================
  // 4. LOG PROCESSOR (Event Processing Only)
  // =============================================
  
  console.log('📋 4. Enhanced Log Processor (Event Processing Only)');
  console.log('   Single responsibility: Process events with pre-cached validator info');
  
  const config: ProcessingConfig = {
    batchSize: 100,
    batchTimeoutMs: 5000,
    maxRetries: 3,
    enableQCParsing: true,
    enableVoteChainAnalysis: true,
    enableGeographicIntelligence: true,
    parallelProcessing: true,
    maxConcurrentBatches: 5,
    preProcessDNS: true // New flag for DNS pre-processing
  };
  
  const logProcessor = new MonadLogProcessor(config);
  await logProcessor.initialize();
  
  console.log('   ✅ Log processor initialized with pre-cached validator information');
  console.log('   🚀 Ready for high-performance log processing without DNS lookups');
  
  const processorStats = logProcessor.getValidatorStats();
  console.log(`   📊 Processor has access to ${processorStats.totalValidators} validators`);
  
  console.log('');

  // =============================================
  // 5. PERFORMANCE COMPARISON
  // =============================================
  
  console.log('⚡ 5. Performance Benefits');
  console.log('   ✅ Separated concerns: Each service has single responsibility');
  console.log('   ✅ Pre-cached data: No DNS lookups during log processing');
  console.log('   ✅ Fast synchronous lookups: getValidatorInfoSync() method');
  console.log('   ✅ Batch processing: Efficient DNS resolution in batches');
  console.log('   ✅ Independent scaling: Each service can be optimized separately');
  
  // Test synchronous lookup performance
  console.log('\n   📈 Performance test: Synchronous validator lookups');
  const testNodeIds = allMappings.slice(0, 10).map(m => m.nodeId);
  
  const startTime = Date.now();
  let foundCount = 0;
  
  for (const nodeId of testNodeIds) {
    const info = validatorInfoService.getValidatorInfoSync(nodeId);
    if (info) foundCount++;
  }
  
  const endTime = Date.now();
  console.log(`   ⚡ Looked up ${foundCount}/${testNodeIds.length} validators in ${endTime - startTime}ms`);
  console.log(`   🎯 Average: ${((endTime - startTime) / testNodeIds.length).toFixed(2)}ms per lookup`);
  
  console.log('');

  // =============================================
  // 6. ARCHITECTURE SUMMARY
  // =============================================
  
  console.log('📋 6. Architecture Summary');
  console.log('');
  console.log('   OLD ARCHITECTURE (Mixed Responsibilities):');
  console.log('   ❌ ValidatorRegistry: epochs + stakes + DNS mappings');
  console.log('   ❌ ValidatorDNSMapper: tightly coupled with registry');
  console.log('   ❌ LogProcessor: DNS lookups during processing');
  console.log('   ❌ Complex coupling between services');
  console.log('');
  console.log('   NEW ARCHITECTURE (Single Responsibility):');
  console.log('   ✅ ValidatorRegistry: Only epochs/stakes from validators.toml');
  console.log('   ✅ DNSMapper: Only DNS resolution from node.toml');
  console.log('   ✅ ValidatorInfoService: Combines both for processors');
  console.log('   ✅ LogProcessor: Only processes events');
  console.log('   ✅ Independent, focused services');
  console.log('');
  console.log('   BENEFITS:');
  console.log('   🚀 Better performance: Pre-cached data, no DNS during processing');
  console.log('   🔧 Easier maintenance: Single responsibility per service');
  console.log('   📈 Better scalability: Independent service optimization');
  console.log('   🧪 Better testing: Focused unit tests per service');
  console.log('   🛠️  Better debugging: Clear separation of concerns');
  
  console.log('\n✅ New architecture demonstration completed successfully!');
}

async function main() {
  try {
    await demonstrateNewArchitecture();
  } catch (error) {
    console.error('❌ Demo failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} 