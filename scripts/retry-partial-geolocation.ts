#!/usr/bin/env npx tsx

import { ValidatorInfoService } from '../src/services/validator-info-service';
import { ValidatorRegistry } from '../src/services/validator-registry';
import { DNSMapperService } from '../src/services/dns-mapper';

/**
 * Script to retry DNS resolution for validators with partial geolocation data
 * 
 * This script finds validators where:
 * - region/country != unknown 
 * - datacenter == unknown
 * 
 * And retries DNS resolution for only those validators.
 */

async function main() {
  console.log('🚀 Starting Partial Geolocation Retry Script...');
  
  try {
    // Initialize services
    const validatorRegistry = new ValidatorRegistry();
    const dnsMapper = new DNSMapperService();
    const validatorInfoService = new ValidatorInfoService(validatorRegistry, dnsMapper);
    
    console.log('🔧 Initializing services...');
    await validatorInfoService.initialize();
    
    // First, let's see what we have in cache
    const stats = validatorInfoService.getStats();
    console.log('\n📊 Current Statistics:');
    console.log(`- Total validators: ${stats.totalValidators}`);
    console.log(`- Validators with DNS: ${stats.validatorsWithDNS}`);
    console.log(`- DNS coverage: ${stats.dnsCoverage.toFixed(1)}%`);
    console.log(`- Cached validators: ${stats.cacheStats.totalCached}`);
    
    // Check for validators with partial geolocation data
    console.log('\n🔍 Checking for validators with partial geolocation data...');
    
    const allValidatorInfos = dnsMapper.getAllDNSInfo();
    const partialDataValidators = allValidatorInfos.filter(info => {
      const hasKnownRegion = Boolean(info.country && info.country !== 'unknown');
      const hasUnknownDatacenter = Boolean(!info.datacenter || info.datacenter === 'unknown');
      return hasKnownRegion && hasUnknownDatacenter;
    });
    
    console.log(`Found ${partialDataValidators.length} validators with partial geolocation data:`);
    
    if (partialDataValidators.length > 0) {
      console.log('\n🔍 Validators with partial data:');
      for (const validator of partialDataValidators.slice(0, 10)) { // Show first 10
        console.log(`- ${validator.nodeId.substring(0, 8)}... (${validator.country}, datacenter: ${validator.datacenter || 'unknown'})`);
      }
      
      if (partialDataValidators.length > 10) {
        console.log(`... and ${partialDataValidators.length - 10} more`);
      }
      
      // Ask for confirmation
      console.log(`\n❓ Do you want to retry DNS resolution for these ${partialDataValidators.length} validators? (y/N)`);
      
      // For script automation, we'll proceed automatically
      // In interactive mode, you could add readline here
      const proceed = process.env.AUTO_PROCEED === 'true' || process.argv.includes('--auto');
      
      if (proceed) {
        console.log('✅ Proceeding with retry...');
        
        // Trigger the retry
        const result = await validatorInfoService.retryPartialValidators();
        
        console.log('\n📊 Retry Results:');
        console.log(`- Validators found with partial data: ${result.found}`);
        console.log(`- Successfully processed: ${result.successful}`);
        console.log(`- Improved datacenter info: ${result.improved}`);
        console.log(`- Success rate: ${result.found > 0 ? ((result.successful / result.found) * 100).toFixed(1) : 0}%`);
        console.log(`- Improvement rate: ${result.found > 0 ? ((result.improved / result.found) * 100).toFixed(1) : 0}%`);
        
        if (result.improved > 0) {
          console.log('\n✅ Some validators had their datacenter information improved!');
          
          // Show updated stats
          const newStats = validatorInfoService.getStats();
          console.log('\n📊 Updated Statistics:');
          console.log(`- DNS coverage: ${newStats.dnsCoverage.toFixed(1)}%`);
          console.log(`- Cache hit rate: ${newStats.cacheStats.hitRate.toFixed(1)}%`);
        }
        
      } else {
        console.log('❌ Retry cancelled');
      }
      
    } else {
      console.log('✅ No validators found with partial geolocation data');
    }
    
    console.log('\n✅ Script completed successfully');
    
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

// Handle command line arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: npx tsx scripts/retry-partial-geolocation.ts [options]

Options:
  --auto        Proceed automatically without confirmation
  --help, -h    Show this help message

Environment Variables:
  AUTO_PROCEED=true   Same as --auto flag

This script finds validators where region/country is known but datacenter is unknown,
and retries DNS resolution for those validators to improve geolocation data.
`);
  process.exit(0);
}

if (require.main === module) {
  main().catch(console.error);
}

export { main }; 