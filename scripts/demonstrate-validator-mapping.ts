#!/usr/bin/env ts-node

import { validatorRegistry } from '../src/services/validator-registry';

// ❌ OLD METHOD (deprecated) - kept for demonstration only
function oldMapValidatorPositions(bitmap: number[]): Array<{
  validatorId: string;
  participated: boolean;
  position: number;
}> {
  return bitmap.map((bit, index) => ({
    validatorId: `validator_${index}`, // ← DEPRECATED: placeholder names
    participated: bit === 1,
    position: index
  }));
}

async function demonstrateValidatorMapping() {
  console.log('🚀 Monad Validator Analytics: BitVec Mapping Improvement\n');
  console.log('=' .repeat(80));
  console.log('PROBLEM SOLVED: Mapping BitVec Positions to Actual Validator Addresses');
  console.log('=' .repeat(80));

  try {
    // Initialize the registry
    await validatorRegistry.initialize();
    
    // Create a realistic sample from logs: [0, 1, 1, 1, 0, 0, 1, 0, 1, 1, ...]
    const sampleBitVec = [
      0, 1, 1, 1, 0, 0, 1, 0, 1, 1,  // First 10 positions
      1, 0, 1, 1, 0, 1, 0, 1, 1, 0,  // Next 10 positions 
      1, 1, 0, 1, 0, 0, 1, 1, 0, 1   // Next 10 positions
    ];
    
    // Extend to full 169 validators with random participation
    while (sampleBitVec.length < 169) {
      sampleBitVec.push(Math.random() > 0.3 ? 1 : 0); // ~70% participation
    }

    const participatingCount = sampleBitVec.filter(bit => bit === 1).length;
    const participationRate = (participatingCount / sampleBitVec.length * 100).toFixed(1);

    console.log(`\n📊 Sample QC Participation Data:`);
    console.log(`   Total Validators: ${sampleBitVec.length}`);
    console.log(`   Participating: ${participatingCount}`);
    console.log(`   Participation Rate: ${participationRate}%`);
    console.log(`   BitVec Sample: [${sampleBitVec.slice(0, 20).join(', ')}, ...]`);

    console.log('\n' + '─'.repeat(80));
    console.log('❌ BEFORE: Using Placeholder Validator Names');
    console.log('─'.repeat(80));

    const oldMapping = oldMapValidatorPositions(sampleBitVec);
    const oldParticipating = oldMapping.filter(v => v.participated).slice(0, 10);
    
    console.log(`\n🔍 Participating Validators (showing first 10 of ${oldMapping.filter(v => v.participated).length}):`);
    oldParticipating.forEach(validator => {
      console.log(`   Position ${validator.position.toString().padStart(3)}: ${validator.validatorId}`);
    });

    console.log('\n❌ Issues with old approach:');
    console.log('   • No real validator identification');
    console.log('   • Cannot track actual validator performance');
    console.log('   • No stake information for analysis');
    console.log('   • Cannot detect validator infrastructure patterns');

    console.log('\n' + '─'.repeat(80));
    console.log('✅ AFTER: Using Real Validator Registry');
    console.log('─'.repeat(80));

    const newMapping = validatorRegistry.mapBitVecToValidators(sampleBitVec, 1);
    const newParticipating = newMapping.filter(v => v.participated).slice(0, 10);
    
    console.log(`\n🎯 Participating Validators (showing first 10 of ${newMapping.filter(v => v.participated).length}):`);
    newParticipating.forEach(validator => {
      const shortId = validator.nodeId.substring(0, 20) + '...';
      console.log(`   Position ${validator.position.toString().padStart(3)}: ${shortId} (stake: ${validator.stake})`);
    });

    console.log('\n✅ Benefits of new approach:');
    console.log('   • Real validator addresses from validators.toml');
    console.log('   • Accurate stake information for weighted analysis');
    console.log('   • Can track individual validator performance over time');
    console.log('   • Enables sophisticated validator analytics');

    console.log('\n' + '─'.repeat(80));
    console.log('📈 Advanced Analytics Now Possible');
    console.log('─'.repeat(80));

    // Calculate advanced metrics
    const participatingValidators = newMapping.filter(v => v.participated);
    const totalStake = participatingValidators.reduce((sum, v) => sum + v.stake, 0);
    const averageStake = totalStake / participatingValidators.length;
    const highStakeValidators = participatingValidators.filter(v => v.stake > averageStake);
    
    console.log('\n📊 Stake-Weighted Analysis:');
    console.log(`   Total Participating Stake: ${totalStake}`);
    console.log(`   Average Stake: ${averageStake.toFixed(2)}`);
    console.log(`   High-Stake Participants: ${highStakeValidators.length}/${participatingValidators.length}`);
    
    // Show stake distribution
    const stakeRanges = {
      '200+': participatingValidators.filter(v => v.stake >= 200).length,
      '100-199': participatingValidators.filter(v => v.stake >= 100 && v.stake < 200).length,
      '10-99': participatingValidators.filter(v => v.stake >= 10 && v.stake < 100).length,
      '1-9': participatingValidators.filter(v => v.stake >= 1 && v.stake < 10).length,
      '0': participatingValidators.filter(v => v.stake === 0).length
    };

    console.log('\n📊 Participating Validators by Stake:');
    Object.entries(stakeRanges).forEach(([range, count]) => {
      if (count > 0) {
        const percentage = (count / participatingValidators.length * 100).toFixed(1);
        console.log(`   ${range.padEnd(10)}: ${count.toString().padStart(3)} validators (${percentage}%)`);
      }
    });

    // Show validator examples by stake category
    console.log('\n🏆 High-Stake Validator Examples:');
    const highStakeExamples = participatingValidators
      .filter(v => v.stake >= 200)
      .slice(0, 3);
    
    highStakeExamples.forEach(validator => {
      const shortId = validator.nodeId.substring(0, 20) + '...';
      console.log(`   Position ${validator.position.toString().padStart(3)}: ${shortId} (stake: ${validator.stake})`);
    });

    console.log('\n💎 Low-Stake Validator Examples:');
    const lowStakeExamples = participatingValidators
      .filter(v => v.stake === 1)
      .slice(0, 3);
    
    lowStakeExamples.forEach(validator => {
      const shortId = validator.nodeId.substring(0, 20) + '...';
      console.log(`   Position ${validator.position.toString().padStart(3)}: ${shortId} (stake: ${validator.stake})`);
    });

    console.log('\n' + '─'.repeat(80));
    console.log('🔧 Integration with Enhanced Processor');
    console.log('─'.repeat(80));

    console.log('\n✅ Updated Features:');
    console.log('   • QCParticipationParser now uses ValidatorRegistry');
    console.log('   • Automatic epoch detection from logs');
    console.log('   • Real-time validator mapping in log processing');
    console.log('   • Enhanced QC participation data with stakes');
    console.log('   • Backward compatibility with fallback to placeholders');

    console.log('\n📋 Updated QCParticipationData interface:');
    console.log('   + nodeId: string           // Real validator address');
    console.log('   + stake: number           // Validator stake amount');
    console.log('   + epoch?: number          // Track epoch context');

    console.log('\n🚀 API Endpoints Enhanced:');
    console.log('   • /validators/performance - now with real validator tracking');
    console.log('   • /network/participation - stake-weighted metrics');
    console.log('   • /analytics/consensus - validator-specific insights');

    console.log('\n' + '=' .repeat(80));
    console.log('✅ SOLUTION COMPLETE: BitVec → Real Validator Mapping');
    console.log('=' .repeat(80));
    console.log('\nThe gap has been closed! 🎉');
    console.log('BitVec positions now map to actual validator addresses with stake info.');

  } catch (error) {
    console.error('❌ Demonstration failed:', error);
  }
}

// Run demonstration
if (require.main === module) {
  demonstrateValidatorMapping().catch(console.error);
}

export { demonstrateValidatorMapping }; 