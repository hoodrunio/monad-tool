#!/usr/bin/env node

import { IntelligentDNSParser } from '../src/utils/dns-parser';
import { NetworkDiscoveryService } from '../src/utils/network-discovery';
import { DNSCacheManager } from '../src/utils/dns-cache';

/**
 * Test script for the improved DNS parser functionality with the validator URLs from the dns.toml file
 * Tests with real validator URLs from the Monad testnet
 */

// Sample validator URLs from dns.toml
const testValidators = [
  'mf-testnet-2-val-tsw-pit-004.monadinfra.com:8000',
  'mf-testnet-2-val-tsw-fra-002.monadinfra.com:8000',
  'bue-004.devcore4.com:8000',
  'monad.testnet.lux8.net:8000',
  'monad.testnet.natsai.xyz:8000',
  'monad-testnet2-val01.01no.de:8000',
  'monad.0xhub.xyz:8000',
  'monad-testnet.stakecraft.com:8000',
  'tn.monad.stakingcabin.com:8000',
  'monad-testnet-validator.stakesquid.com:8000',
  'monad-tn.lakestake.io:8000',
  'monad-test-val1.artifact.systems:8000',
  'tsw-sgp2-monad-testnet-val2.nodes.asymmetric.re:8000',
  'vn.testnet2.monad.despreadlabs.io:8000',
  't-vl-monad-syd-1.piertwo.io:8000',
  'monad-testnet.stakely.io:8000',
  'monad.testnet.synergynodes.com:8000',
  'validator.monad-testnet-2.ccvalidators.com:8000',
  'monad.eks-us-west-2-utility.staging.staked.cloud:8000',
  'testnet-monad.1xp.vc:8000'
];

async function testDNSParser(): Promise<void> {
  console.log('🚀 Testing Intelligent DNS Parser');
  console.log('=' .repeat(50));
  
  const parser = new IntelligentDNSParser();
  
  // Test individual DNS parsing
  console.log('\n📋 Individual DNS Parsing Results:');
  console.log('-'.repeat(30));
  
  for (const validator of testValidators.slice(0, 5)) { // Test first 5 for demo
    try {
      console.log(`\n🔍 Analyzing: ${validator}`);
      const result = await parser.parse(validator);
      
      console.log(`  Provider: ${result.provider}`);
      console.log(`  Network Type: ${result.networkType}`);
      console.log(`  Network: ${result.network}`);
      console.log(`  Instance: ${result.instance || 'N/A'}`);
      console.log(`  Parsing Method: ${result.parsingMethod}`);
      console.log(`  Location: ${result.locationInfo.city}, ${result.locationInfo.country}`);
      console.log(`  Datacenter: ${result.locationInfo.datacenter}`);
      console.log(`  ISP: ${result.locationInfo.isp}`);
      console.log(`  IP: ${result.locationInfo.ip}`);
      
      if (result.locationInfo.coordinates) {
        console.log(`  Coordinates: ${result.locationInfo.coordinates.lat}, ${result.locationInfo.coordinates.lng}`);
      }
      
    } catch (error) {
      console.error(`  ❌ Error parsing ${validator}:`, error instanceof Error ? error.message : error);
    }
    
    // Add delay to be respectful to external services
    await delay(2000);
  }
}

async function testNetworkDiscovery(): Promise<void> {
  console.log('\n\n🌐 Testing Network Discovery Service');
  console.log('=' .repeat(50));
  
  const discoveryService = new NetworkDiscoveryService();
  
  try {
    // Use a smaller subset for testing to avoid overwhelming external services
    const testSubset = testValidators.slice(0, 10);
    console.log(`\n📊 Analyzing network topology for ${testSubset.length} validators...`);
    
    const networkResult = await discoveryService.discoverNetwork(testSubset);
    
    console.log('\n📈 Network Analysis Results:');
    console.log(`  Total Validators: ${networkResult.totalValidators}`);
    console.log(`  Unique Providers: ${networkResult.uniqueProviders.length}`);
    console.log(`  Providers: ${networkResult.uniqueProviders.join(', ')}`);
    
    console.log('\n🏢 Provider Distribution:');
    networkResult.providerDistribution.forEach((count, provider) => {
      console.log(`  ${provider}: ${count} validators`);
    });
    
    console.log('\n🌍 Geographic Distribution:');
    networkResult.geographicDistribution.forEach((count, location) => {
      console.log(`  ${location}: ${count} validators`);
    });
    
    console.log('\n🏭 Datacenter Distribution:');
    networkResult.datacenterDistribution.forEach((count, datacenter) => {
      console.log(`  ${datacenter}: ${count} validators`);
    });
    
    // Analyze centralization risks
    const risks = discoveryService.analyzeCentralizationRisks(networkResult);
    console.log('\n⚠️  Centralization Risk Analysis:');
    console.log(`  Provider Risk: ${(risks.providerRisk * 100).toFixed(1)}%`);
    console.log(`  Geographic Risk: ${(risks.geographicRisk * 100).toFixed(1)}%`);
    console.log(`  Datacenter Risk: ${(risks.datacenterRisk * 100).toFixed(1)}%`);
    console.log(`  Overall Risk: ${risks.overallRisk.toUpperCase()}`);
    
  } catch (error) {
    console.error('❌ Network discovery failed:', error instanceof Error ? error.message : error);
  }
}

async function testDNSCache(): Promise<void> {
  console.log('\n\n💾 Testing DNS Cache Manager');
  console.log('=' .repeat(50));
  
  const cacheManager = new DNSCacheManager({
    defaultTTL: 300000, // 5 minutes for testing
    maxCacheSize: 100,
    enableAutoCleanup: true
  });
  
  const parser = new IntelligentDNSParser();
  
  console.log('\n📦 Cache Operations Test:');
  
  // Test cache miss
  const hostname = testValidators[0].split(':')[0];
  console.log(`\n🔍 Testing cache for: ${hostname}`);
  console.log(`  Cache hit: ${cacheManager.has(hostname)}`);
  
  // Parse and cache
  console.log('  Parsing and caching...');
  try {
    const result = await parser.parse(testValidators[0]);
    cacheManager.set(hostname, result);
    console.log(`  ✅ Cached successfully`);
    console.log(`  Cache hit: ${cacheManager.has(hostname)}`);
    
    // Test cache hit
    const cachedResult = cacheManager.get(hostname);
    console.log(`  ✅ Retrieved from cache: ${cachedResult?.provider}`);
    
  } catch (error) {
    console.error(`  ❌ Cache test failed:`, error instanceof Error ? error.message : error);
  }
  
  // Get cache stats
  const stats = cacheManager.getStats();
  console.log('\n📊 Cache Statistics:');
  console.log(`  Total Entries: ${stats.totalEntries}`);
  console.log(`  Valid Entries: ${stats.validEntries}`);
  console.log(`  Expired Entries: ${stats.expiredEntries}`);
  console.log(`  Hit Rate: ${(stats.hitRate * 100).toFixed(1)}%`);
  console.log(`  Memory Usage: ${stats.memoryUsage} bytes`);
  
  // Cleanup
  cacheManager.destroy();
}

async function demonstrateRealWorldUsage(): Promise<void> {
  console.log('\n\n🎯 Real-World Usage Examples');
  console.log('=' .repeat(50));
  
  const parser = new IntelligentDNSParser();
  
  // Test different URL patterns
  const urlPatterns = [
    'mf-testnet-2-val-tsw-pit-004.monadinfra.com:8000', // Official Monad infra
    'monad.testnet.stakecraft.com:8000',                 // Standard pattern
    'tn.monad.stakingcabin.com:8000',                   // Subdomain pattern
    'monad-test-val1.artifact.systems:8000',            // Complex subdomain
    'tsw-sgp2-monad-testnet-val2.nodes.asymmetric.re:8000' // Geographic pattern
  ];
  
  console.log('\n🔬 Pattern Analysis:');
  
  for (const url of urlPatterns) {
    try {
      console.log(`\n📝 URL: ${url}`);
      const result = await parser.parse(url);
      console.log(`  ├─ Provider: ${result.provider}`);
      console.log(`  ├─ Pattern: ${result.parsingMethod}`);
      console.log(`  ├─ Domain Parts: [${result.rawDomainParts.join(', ')}]`);
      console.log(`  └─ Location: ${result.locationInfo.city || 'unknown'}, ${result.locationInfo.country || 'unknown'}`);
      
      await delay(1500); // Be respectful to external services
      
    } catch (error) {
      console.error(`  ❌ Failed to analyze ${url}:`, error instanceof Error ? error.message : error);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('🔧 Monad DNS Parser Test Suite');
  console.log('Testing improved DNS parsing utilities');
  console.log('');
  
  try {
    // Run tests
    await testDNSParser();
    await testNetworkDiscovery();
    await testDNSCache();
    await demonstrateRealWorldUsage();
    
    console.log('\n\n✅ All tests completed!');
    console.log('📝 Note: Some external API calls may fail due to rate limiting or network issues.');
    console.log('🔄 The parser gracefully handles failures and provides fallback values.');
    
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  }
}

// Run the test suite
if (require.main === module) {
  main().catch(console.error);
}

export { testDNSParser, testNetworkDiscovery, testDNSCache }; 