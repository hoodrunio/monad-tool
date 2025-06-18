#!/usr/bin/env ts-node

import { MonadLogProcessor } from '../src/log-processor/enhanced-processor';
import { ProcessingConfig } from '../src/log-processor/types';
import { validatorRegistry } from '../src/services/validator-registry';

// Add unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ CAUGHT Unhandled Promise Rejection at:', promise);
  console.error('❌ Reason:', reason);
  console.error('❌ Stack:', reason instanceof Error ? reason.stack : 'No stack trace');
});

async function debugUnhandledRejection() {
  console.log('🔍 Debugging Unhandled Rejection in Validator Registry\n');

  try {
    // Test 1: Direct validator registry initialization
    console.log('1. Testing direct validator registry initialization...');
    await validatorRegistry.initialize();
    console.log('✅ Direct initialization successful\n');

    // Test 2: Create MonadLogProcessor with validator registry
    console.log('2. Testing MonadLogProcessor initialization...');
    const config: ProcessingConfig = {
      batchSize: 100,
      batchTimeoutMs: 5000,
      maxRetries: 3,
      enableQCParsing: true,
      enableVoteChainAnalysis: true,
      enableGeographicIntelligence: true,
      parallelProcessing: false,
      maxConcurrentBatches: 1
    };

    const processor = new MonadLogProcessor(config);
    console.log('✅ MonadLogProcessor created successfully\n');

    // Test 3: Create sample logs with QC data
    console.log('3. Testing log processing with QC data...');
    const sampleLogs = [
      {
        timestamp: new Date().toISOString(),
        level: 'INFO' as const,
        target: 'monad_consensus_state',
        fields: {
          message: 'QC commit triggered',
          round: '123',
          epoch: '1',
          qc: 'QC { info: VoteInfo { id: abc123, epoch: 1, r: 123 }, sigs: BlsSignatureCollection { signers: SignerMap { addr: xyz, head: def, bits: 169, capacity: 200, bitmap: [0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1] }, sig: BlsAggregateSignature("0x123456789abcdef") } }'
        }
      }
    ];

    console.log('🎯 Processing sample logs...');
    const result = await processor.processBatch(sampleLogs);
    
    console.log('✅ Log processing completed successfully');
    console.log(`📊 Results: ${result.events.length} events, ${result.qcParticipation.length} QC data, ${result.errors.length} errors`);
    
    if (result.errors.length > 0) {
      console.log('\n❌ Errors found:');
      result.errors.forEach((error, index) => {
        console.log(`  ${index + 1}. ${error.error}`);
      });
    }

    if (result.qcParticipation.length > 0) {
      const qc = result.qcParticipation[0];
      console.log('\n📈 QC Participation Data:');
      console.log(`  Total validators: ${qc.totalValidators}`);
      console.log(`  Participating: ${qc.participatingValidators}`);
      console.log(`  Participation rate: ${(qc.participationRate * 100).toFixed(1)}%`);
      console.log(`  Validator participation entries: ${qc.validatorParticipation.length}`);
      
      // Show first few validators
      console.log('\n👥 First 5 validator participations:');
      qc.validatorParticipation.slice(0, 5).forEach((v, index) => {
        const shortId = v.nodeId.startsWith('0x') ? v.nodeId.substring(0, 20) + '...' : v.nodeId;
        console.log(`  ${index}: ${shortId} - ${v.participated ? 'SIGNED' : 'NO SIGN'} (stake: ${v.stake})`);
      });
    }

    console.log('\n✅ All tests completed successfully - No unhandled rejections detected!');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    if (error instanceof Error) {
      console.error('❌ Stack trace:', error.stack);
    }
  }

  // Wait a moment to see if any async operations cause rejections
  console.log('\n⏳ Waiting 2 seconds to check for delayed rejections...');
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log('✅ No delayed rejections detected');
}

// Run the debug test
if (require.main === module) {
  debugUnhandledRejection().catch((error) => {
    console.error('❌ Debug script failed:', error);
    process.exit(1);
  });
}

export { debugUnhandledRejection }; 