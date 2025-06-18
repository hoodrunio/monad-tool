#!/usr/bin/env node

import { MonadLogProcessor } from '../src/log-processor/enhanced-processor';
import { 
  EnhancedDNSProcessor,
  createEnhancedDNSProcessor
} from '../src/utils';
import { ProcessingConfig, RawLog } from '../src/log-processor/types';

/**
 * Test script for DNS integration with the Monad analytics application
 * Tests the enhanced DNS functionality and integration
 */

async function testDNSIntegration() {
  console.log('🚀 Testing DNS Integration with Monad Analytics Application\n');

  // Initialize the enhanced DNS processor
  const dnsProcessor = createEnhancedDNSProcessor();
  
  // Initialize log processor with enhanced DNS capabilities
  const config: ProcessingConfig = {
    batchSize: 100,
    batchTimeoutMs: 5000,
    maxRetries: 3,
    enableQCParsing: true,
    enableVoteChainAnalysis: true,
    enableGeographicIntelligence: true,
    parallelProcessing: true,
    maxConcurrentBatches: 2
  };
  
  const logProcessor = new MonadLogProcessor(config);

  console.log('1. Testing Single DNS Analysis');
  console.log('================================');
  
  // Test sample validator URLs from the testnet
  const testValidators = [
    'mf-testnet-2-val-tsw-pit-004.monadinfra.com:8000',
    'bue-004.devcore4.com:8000',
    'monad.testnet.lux8.net:8000',
    'monad-testnet-validator.stakesquirrel.com:8000',
    'monad-testnet.stakecraft.com:8000'
  ];

  for (const validator of testValidators.slice(0, 3)) {
    try {
      console.log(`\n📍 Analyzing: ${validator}`);
      const result = await dnsProcessor.processValidatorDNS(validator);
      
      console.log(`   Provider: ${result.provider}`);
      console.log(`   Location: ${result.locationInfo.city}, ${result.locationInfo.country}`);
      console.log(`   Datacenter: ${result.locationInfo.datacenter}`);
      console.log(`   Network Type: ${result.networkType}`);
      console.log(`   Parsing Method: ${result.parsingMethod}`);
      
      if (result.locationInfo.coordinates) {
        console.log(`   Coordinates: ${result.locationInfo.coordinates.lat}, ${result.locationInfo.coordinates.lng}`);
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error}`);
    }
  }

  console.log('\n\n2. Testing Batch DNS Analysis');
  console.log('==============================');
  
  const validatorBatch = testValidators.map((dns, index) => ({
    validatorId: `validator_${index + 1}`,
    dnsAddress: dns
  }));
  
  try {
    const batchResults = await dnsProcessor.processBatchValidatorDNS(validatorBatch);
    console.log(`✅ Successfully processed ${batchResults.length} validators in batch`);
    
    const providerCounts: Record<string, number> = {};
    const locationCounts: Record<string, number> = {};
    
    batchResults.forEach(result => {
      providerCounts[result.provider] = (providerCounts[result.provider] || 0) + 1;
      const location = `${result.locationInfo.city}, ${result.locationInfo.country}`;
      locationCounts[location] = (locationCounts[location] || 0) + 1;
    });
    
    console.log('\n📊 Provider Distribution:');
    Object.entries(providerCounts).forEach(([provider, count]) => {
      console.log(`   ${provider}: ${count} validators`);
    });
    
    console.log('\n🌍 Geographic Distribution:');
    Object.entries(locationCounts).forEach(([location, count]) => {
      console.log(`   ${location}: ${count} validators`);
    });
    
  } catch (error) {
    console.log(`❌ Batch processing error: ${error}`);
  }

  console.log('\n\n3. Testing Network Topology Analysis');
  console.log('=====================================');
  
  try {
    const topology = await dnsProcessor.analyzeNetworkTopology();
    if (topology) {
      console.log(`✅ Network analysis completed`);
      console.log(`   Total validators: ${topology.totalValidators}`);
      console.log(`   Unique providers: ${topology.uniqueProviders.length}`);
      console.log(`   Diversity score: ${topology.diversityScore.toFixed(2)}`);
      console.log(`   Centralization risk: ${topology.centralizationRisk}`);
      
      console.log('\n🏢 Provider Metrics:');
      Object.entries(topology.providerMetrics).forEach(([provider, metrics]) => {
        console.log(`   ${provider}:`);
        console.log(`     Validators: ${metrics.validatorCount}`);
        console.log(`     Performance: ${metrics.avgPerformance.toFixed(2)}`);
        console.log(`     Risk Score: ${metrics.riskScore.toFixed(2)}`);
      });
    } else {
      console.log('❌ Network topology analysis not available');
    }
  } catch (error) {
    console.log(`❌ Network topology error: ${error}`);
  }

  console.log('\n\n4. Testing Centralization Risk Analysis');
  console.log('========================================');
  
  try {
    const risks = await logProcessor.getCentralizationRisks();
    if (risks) {
      console.log(`✅ Centralization risk analysis completed`);
      console.log(`   Provider Risk: ${risks.providerRisk.toFixed(2)}`);
      console.log(`   Geographic Risk: ${risks.geographicRisk.toFixed(2)}`);
      console.log(`   Datacenter Risk: ${risks.datacenterRisk.toFixed(2)}`);
      console.log(`   Overall Risk: ${risks.overallRisk}`);
      
      if (risks.riskFactors.length > 0) {
        console.log('\n⚠️  Risk Factors:');
        risks.riskFactors.forEach(factor => {
          console.log(`   - ${factor}`);
        });
      }
    } else {
      console.log('❌ Centralization risk analysis not available');
    }
  } catch (error) {
    console.log(`❌ Centralization risk error: ${error}`);
  }

  console.log('\n\n5. Testing Log Processing with Enhanced DNS');
  console.log('===========================================');
  
  // Create sample log entries for testing
  const sampleLogs: RawLog[] = [
    {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      target: 'monad_consensus_state',
      fields: {
        message: 'QC commit triggered',
        round: '12345',
        epoch: '1',
        block_num: '100',
        author: 'validator_123',
        author_dns: 'mf-testnet-2-val-tsw-pit-004.monadinfra.com:8000',
        qc: 'QcData { info: VoteInfo { id: abc123, epoch: 1, r: 12345 }, sigs: { signers: { bits: 169 } } }'
      }
    },
    {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      target: 'monad_consensus_state',
      fields: {
        message: 'Block committed',
        round: '12346',
        epoch: '1',
        block_num: '101',
        author: 'validator_456',
        author_dns: 'monad.testnet.lux8.net:8000'
      }
    }
  ];
  
  try {
    const processingResult = await logProcessor.processBatch(sampleLogs);
    console.log(`✅ Processed ${sampleLogs.length} sample logs`);
    console.log(`   Events generated: ${processingResult.events.length}`);
    console.log(`   QC participation data: ${processingResult.qcParticipation.length}`);
    console.log(`   Validator infrastructure: ${processingResult.validatorInfrastructure.length}`);
    console.log(`   Errors: ${processingResult.errors.length}`);
    
    if (processingResult.events.length > 0) {
      const event = processingResult.events[0] as any;
      console.log('\n📝 Sample processed event:');
      console.log(`   Validator ID: ${event.validatorId}`);
      console.log(`   DNS: ${event.validatorDns}`);
      console.log(`   Geographic Region: ${event.geographicRegion}`);
      console.log(`   Infrastructure Provider: ${event.infrastructureProvider}`);
      console.log(`   Datacenter Code: ${event.datacenterCode}`);
    }
    
  } catch (error) {
    console.log(`❌ Log processing error: ${error}`);
  }

  console.log('\n\n6. Testing DNS Cache Performance');
  console.log('=================================');
  
  const cacheStats = logProcessor.getDNSCacheStats();
  console.log(`✅ DNS Cache Statistics:`);
  console.log(`   Total entries: ${cacheStats.totalEntries}`);
  console.log(`   Valid entries: ${cacheStats.validEntries}`);
  console.log(`   Expired entries: ${cacheStats.expiredEntries}`);
  console.log(`   Hit rate: ${(cacheStats.hitRate * 100).toFixed(2)}%`);
  console.log(`   Memory usage: ${cacheStats.memoryUsage.toFixed(2)} MB`);

  console.log('\n\n✅ DNS Integration Testing Complete!');
  console.log('=====================================');
  
  // Clean up
  logProcessor.destroy();
  dnsProcessor.destroy();
  
  console.log('🧹 Resources cleaned up successfully');
}

// Run the test
if (require.main === module) {
  testDNSIntegration()
    .then(() => {
      console.log('\n🎉 All tests completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Test failed:', error);
      process.exit(1);
    });
} 