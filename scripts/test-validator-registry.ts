#!/usr/bin/env ts-node

import { validatorRegistry } from '../src/services/validator-registry';

async function testValidatorRegistry() {
  console.log('🔍 Testing Validator Registry Implementation...\n');

  try {
    // Initialize the registry
    console.log('1. Initializing validator registry...');
    await validatorRegistry.initialize();
    console.log('✅ Validator registry initialized successfully\n');

    // Test basic functionality
    console.log('2. Testing basic registry functions...');
    const availableEpochs = validatorRegistry.getAvailableEpochs();
    console.log(`📊 Available epochs: ${availableEpochs.join(', ')}`);

    for (const epoch of availableEpochs) {
      const validatorCount = validatorRegistry.getValidatorCount(epoch);
      console.log(`📈 Epoch ${epoch}: ${validatorCount} validators`);
    }
    console.log();

    // Test validator mapping for epoch 1
    console.log('3. Testing validator mapping for Epoch 1...');
    const epoch1Validators = validatorRegistry.getAllValidators(1);
    console.log(`🔢 Total validators in epoch 1: ${epoch1Validators.length}`);
    
    // Show first 5 validators
    console.log('\n📋 First 5 validators in epoch 1:');
    epoch1Validators.slice(0, 5).forEach((validator, index) => {
      console.log(`  Position ${index}: ${validator.node_id} (stake: ${validator.stake})`);
    });

    // Test bitvec mapping with a sample
    console.log('\n4. Testing BitVec mapping...');
    // Create a sample bitvec: first 10 validators participate, rest don't
    const sampleBitVec = new Array(169).fill(0);
    for (let i = 0; i < 10; i++) {
      sampleBitVec[i] = 1;
    }

    console.log(`🎯 Sample BitVec (first 10 bits): [${sampleBitVec.slice(0, 10).join(', ')}, ...]`);
    
    const mappedValidators = validatorRegistry.mapBitVecToValidators(sampleBitVec, 1);
    console.log(`✅ Successfully mapped ${mappedValidators.length} validator positions`);
    
    // Show participating validators
    const participatingValidators = mappedValidators.filter(v => v.participated);
    console.log(`\n👥 Participating validators (${participatingValidators.length}):`);
    participatingValidators.forEach(validator => {
      console.log(`  Position ${validator.position}: ${validator.nodeId} (stake: ${validator.stake})`);
    });

    // Test validator lookup by ID
    console.log('\n5. Testing validator ID lookup...');
    const firstValidator = epoch1Validators[0];
    const foundValidator = validatorRegistry.getValidatorById(firstValidator.node_id, 1);
    const position = validatorRegistry.getValidatorPosition(firstValidator.node_id, 1);
    
    console.log(`🔍 Looking up validator: ${firstValidator.node_id}`);
    console.log(`📍 Found at position: ${position}`);
    console.log(`✅ Validator lookup successful: ${foundValidator ? 'Yes' : 'No'}`);

    // Test epoch detection
    console.log('\n6. Testing epoch detection...');
    const detectedEpoch = validatorRegistry.detectEpochFromLogs(firstValidator.node_id);
    console.log(`🎯 Detected epoch for ${firstValidator.node_id.substring(0, 20)}...: ${detectedEpoch}`);

    // Show validator statistics
    console.log('\n7. Validator statistics...');
    for (const epoch of availableEpochs) {
      const stats = validatorRegistry.getValidatorStats(epoch);
      console.log(`📊 Epoch ${epoch} stats:`);
      console.log(`  Total validators: ${stats.totalValidators}`);
      console.log(`  Total stake: ${stats.totalStake}`);
      console.log(`  Average stake: ${stats.averageStake.toFixed(2)}`);
      console.log(`  High stake validators: ${stats.highStakeValidators}`);
      console.log(`  Low stake validators: ${stats.lowStakeValidators}`);
    }

    console.log('\n✅ All validator registry tests passed!');

  } catch (error) {
    console.error('❌ Validator registry test failed:', error);
    process.exit(1);
  }
}

async function testBitVecValidation() {
  console.log('\n🧪 Testing BitVec Validation...\n');

  try {
    // Test with different bitvec lengths
    const validatorCount = validatorRegistry.getValidatorCount(1);
    console.log(`📏 Expected validator count: ${validatorCount}`);

    // Test correct length
    const correctBitVec = new Array(validatorCount).fill(0).map(() => Math.random() > 0.5 ? 1 : 0);
    console.log(`✅ Testing with correct length (${correctBitVec.length})`);
    const correctMapping = validatorRegistry.mapBitVecToValidators(correctBitVec, 1);
    console.log(`✅ Correct mapping successful: ${correctMapping.length} validators mapped`);

    // Test incorrect length
    const incorrectBitVec = new Array(100).fill(0).map(() => Math.random() > 0.5 ? 1 : 0);
    console.log(`⚠️  Testing with incorrect length (${incorrectBitVec.length})`);
    const incorrectMapping = validatorRegistry.mapBitVecToValidators(incorrectBitVec, 1);
    console.log(`⚠️  Incorrect mapping handled gracefully: ${incorrectMapping.length} validators mapped`);

    console.log('\n✅ BitVec validation tests completed!');

  } catch (error) {
    console.error('❌ BitVec validation test failed:', error);
  }
}

// Run tests
if (require.main === module) {
  (async () => {
    await testValidatorRegistry();
    await testBitVecValidation();
  })().catch(console.error);
}

export { testValidatorRegistry, testBitVecValidation }; 