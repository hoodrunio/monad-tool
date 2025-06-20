#!/usr/bin/env npx tsx

/**
 * Test Validator Names
 * 
 * Tests the complete validator name extraction process by:
 * 1. Loading validators from the registry
 * 2. Extracting validator names from DNS hostnames
 * 3. Showing the results
 */

import { ValidatorService } from '../src/services/unified-validator';
import { DomainExtractor } from '../src/services/dns/DomainExtractor';

async function testValidatorNames() {
  console.log('🧪 Testing Validator Name Extraction in Production System\n');
  
  try {
    // Initialize validator service
    console.log('🔧 Initializing Validator Service...');
    const validatorService = new ValidatorService();
    await validatorService.initialize();
    
    // Get validator stats
    const stats = validatorService.getStats();
    console.log(`📊 Validator Service Stats:`);
    console.log(`   Total Validators: ${stats.totalValidators}`);
    console.log(`   With Location: ${stats.validatorsWithLocation}`);
    console.log('');
    
    // Get all validators
    console.log('📋 Loading all validators...');
    const allValidators = await validatorService.getAllValidators();
    
    if (allValidators.length === 0) {
      console.log('❌ No validators found!');
      return;
    }
    
    console.log(`✅ Loaded ${allValidators.length} validators\n`);
    
    // Test domain extraction directly
    console.log('🏷️  Testing Domain Extraction on Real Data:\n');
    
    const domainExtractor = new DomainExtractor();
    const sampleSize = Math.min(10, allValidators.length);
    const sampleValidators = allValidators.slice(0, sampleSize);
    
    console.log('Sample validators with extracted names:');
    console.log('NODE_ID'.padEnd(20) + 'DNS_ADDRESS'.padEnd(45) + 'EXTRACTED_NAME');
    console.log('='.repeat(80));
    
    for (const validator of sampleValidators) {
      const nodeIdShort = validator.nodeId.slice(0, 16) + '...';
      const dnsAddress = validator.location?.dnsAddress || 'No DNS';
      const hostname = validator.location?.hostname || '';
      
      let extractedName = 'unknown';
      if (hostname) {
        extractedName = domainExtractor.extractValidatorName(hostname);
      }
      
      console.log(
        nodeIdShort.padEnd(20) + 
        dnsAddress.padEnd(45) + 
        extractedName
      );
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
    
    // Show statistics of validator names
    console.log('📈 Validator Name Statistics:\n');
    
    const nameDistribution = new Map<string, number>();
    let validatorsWithNames = 0;
    
    for (const validator of allValidators) {
      const hostname = validator.location?.hostname || '';
      let validatorName = 'unknown';
      
      if (hostname) {
        validatorName = domainExtractor.extractValidatorName(hostname);
        if (validatorName !== 'unknown') {
          validatorsWithNames++;
        }
      }
      
      nameDistribution.set(validatorName, (nameDistribution.get(validatorName) || 0) + 1);
    }
    
    // Sort by count
    const sortedNames = Array.from(nameDistribution.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20); // Top 20
    
    console.log('Top validator names (by count):');
    console.log('NAME'.padEnd(25) + 'COUNT'.padEnd(10) + 'PERCENTAGE');
    console.log('-'.repeat(50));
    
    for (const [name, count] of sortedNames) {
      const percentage = ((count / allValidators.length) * 100).toFixed(1);
      console.log(name.padEnd(25) + count.toString().padEnd(10) + percentage + '%');
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
    
    // Summary
    const extractionRate = (validatorsWithNames / allValidators.length) * 100;
    console.log('📊 Summary:');
    console.log(`   Total Validators: ${allValidators.length}`);
    console.log(`   With Valid Names: ${validatorsWithNames}`);
    console.log(`   Extraction Rate: ${extractionRate.toFixed(1)}%`);
    console.log(`   Unique Names: ${nameDistribution.size - (nameDistribution.has('unknown') ? 1 : 0)}`);
    
    if (extractionRate > 80) {
      console.log('✅ Excellent extraction rate!');
    } else if (extractionRate > 60) {
      console.log('⚠️  Good extraction rate, but could be improved');
    } else {
      console.log('❌ Low extraction rate - check DNS data quality');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testValidatorNames().catch(console.error); 