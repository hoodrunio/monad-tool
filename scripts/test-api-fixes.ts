import axios from 'axios';

const BASE_URL = 'http://localhost:4000';

interface ApiTestResult {
  endpoint: string;
  status: 'success' | 'error';
  message: string;
  data?: any;
}

async function testApiEndpoint(endpoint: string, description: string): Promise<ApiTestResult> {
  try {
    console.log(`\n🧪 Testing ${description}...`);
    const response = await axios.get(`${BASE_URL}${endpoint}`, { timeout: 10000 });
    
    if (response.status === 200 && response.data) {
      console.log(`✅ ${description} - SUCCESS`);
      return {
        endpoint,
        status: 'success',
        message: `${description} working correctly`,
        data: response.data
      };
    } else {
      console.log(`❌ ${description} - FAILED: No data returned`);
      return {
        endpoint,
        status: 'error',
        message: `${description} returned no data`
      };
    }
  } catch (error: any) {
    console.log(`❌ ${description} - ERROR: ${error.message}`);
    return {
      endpoint,
      status: 'error',
      message: error.message
    };
  }
}

async function validateDnsNetworkTopology(data: any): Promise<string[]> {
  const issues: string[] = [];
  
  if (!data.success || !data.data) {
    issues.push('Missing success flag or data object');
    return issues;
  }
  
  const topology = data.data;
  
  // Check for realistic validator counts
  if (topology.totalValidators <= 0) {
    issues.push(`Invalid totalValidators: ${topology.totalValidators}`);
  }
  
  if (topology.validatorsWithLocation > topology.totalValidators) {
    issues.push(`validatorsWithLocation (${topology.validatorsWithLocation}) > totalValidators (${topology.totalValidators})`);
  }
  
  // Check geographic distribution
  const geoTotal = Object.values(topology.geographicDistribution).reduce((sum: number, count: any) => sum + count, 0);
  if (Math.abs(geoTotal - topology.validatorsWithLocation) > 5) { // Allow small differences
    issues.push(`Geographic distribution total (${geoTotal}) doesn't match validatorsWithLocation (${topology.validatorsWithLocation})`);
  }
  
  // Check provider distribution
  const providerTotal = Object.values(topology.providerDistribution).reduce((sum: number, count: any) => sum + count, 0);
  if (Math.abs(providerTotal - topology.validatorsWithLocation) > 5) {
    issues.push(`Provider distribution total (${providerTotal}) doesn't match validatorsWithLocation (${topology.validatorsWithLocation})`);
  }
  
  console.log(`   📊 Total validators: ${topology.totalValidators}`);
  console.log(`   📍 Validators with location: ${topology.validatorsWithLocation}`);
  console.log(`   🗺️  Geographic locations: ${Object.keys(topology.geographicDistribution).length}`);
  console.log(`   🏢 Providers: ${Object.keys(topology.providerDistribution).length}`);
  
  return issues;
}

async function validateGeographicDistribution(data: any): Promise<string[]> {
  const issues: string[] = [];
  
  if (!data.distribution || !data.metadata) {
    issues.push('Missing distribution or metadata');
    return issues;
  }
  
  const totalValidators = data.metadata.total_validators;
  const distributionTotal = data.distribution.reduce((sum: number, item: any) => sum + item.validator_count, 0);
  
  if (distributionTotal > totalValidators * 1.1) { // Allow 10% tolerance for double counting detection
    issues.push(`Geographic distribution total (${distributionTotal}) significantly exceeds total validators (${totalValidators}) - possible double counting`);
  }
  
  console.log(`   📊 Total validators: ${totalValidators}`);
  console.log(`   📍 Distribution total: ${distributionTotal}`);
  console.log(`   🗺️  Regions: ${data.distribution.length}`);
  
  return issues;
}

async function validateConsensusEfficiency(data: any): Promise<string[]> {
  const issues: string[] = [];
  
  if (!data.consensus_efficiency || !data.metadata) {
    issues.push('Missing consensus_efficiency or metadata');
    return issues;
  }
  
  const dataPoints = data.metadata.dataPoints;
  if (dataPoints === 0) {
    issues.push('No consensus efficiency data points found');
  }
  
  console.log(`   📊 Data points: ${dataPoints}`);
  console.log(`   ⏰ Time window: ${data.metadata.timeWindow}`);
  
  if (dataPoints > 0) {
    const sample = data.consensus_efficiency[0];
    console.log(`   📈 Sample efficiency: ${sample.consensus_efficiency}%`);
  }
  
  return issues;
}

async function validateProviderDistribution(data: any): Promise<string[]> {
  const issues: string[] = [];
  
  if (!data.success || !data.data || !data.data.distribution) {
    issues.push('Missing success flag, data object, or distribution array');
    return issues;
  }
  
  const providerData = data.data;
  
  // Check for hardcoded values
  const hasHardcodedPerformance = providerData.distribution.some((p: any) => p.avgPerformance === 85);
  if (hasHardcodedPerformance) {
    issues.push('Found hardcoded avgPerformance values (85)');
  }
  
  const hasGenericRegions = providerData.distribution.some((p: any) => 
    p.regions.some((r: string) => r.startsWith('Region for '))
  );
  if (hasGenericRegions) {
    issues.push('Found hardcoded generic region names');
  }
  
  console.log(`   📊 Total validators: ${providerData.totalValidators}`);
  console.log(`   🏢 Providers: ${providerData.distribution.length}`);
  
  // Sample performance data
  if (providerData.distribution.length > 0) {
    const sample = providerData.distribution[0];
    console.log(`   📈 Sample provider: ${sample.provider} (${sample.validatorCount} validators, ${sample.avgPerformance.toFixed(1)}% performance)`);
  }
  
  return issues;
}

async function main() {
  console.log('🔧 Testing API fixes for Monad Validator Analytics\n');
  
  const tests = [
    {
      endpoint: '/api/dns/network-topology',
      description: 'DNS Network Topology',
      validator: validateDnsNetworkTopology
    },
    {
      endpoint: '/api/geographic/distribution',
      description: 'Geographic Distribution',
      validator: validateGeographicDistribution
    },
    {
      endpoint: '/api/network/consensus-efficiency',
      description: 'Consensus Efficiency',
      validator: validateConsensusEfficiency
    },
    {
      endpoint: '/api/dns/provider-distribution',
      description: 'Provider Distribution',
      validator: validateProviderDistribution
    }
  ];
  
  const results: ApiTestResult[] = [];
  let totalIssues = 0;
  
  for (const test of tests) {
    const result = await testApiEndpoint(test.endpoint, test.description);
    results.push(result);
    
    if (result.status === 'success' && test.validator) {
      const issues = await test.validator(result.data);
      if (issues.length > 0) {
        console.log(`   ⚠️  Issues found:`);
        issues.forEach(issue => console.log(`      - ${issue}`));
        totalIssues += issues.length;
      } else {
        console.log(`   ✅ No issues found in response data`);
      }
    }
  }
  
  console.log('\n📋 TEST SUMMARY:');
  console.log('================');
  
  const successCount = results.filter(r => r.status === 'success').length;
  const errorCount = results.filter(r => r.status === 'error').length;
  
  console.log(`✅ Successful endpoints: ${successCount}/${results.length}`);
  console.log(`❌ Failed endpoints: ${errorCount}/${results.length}`);
  console.log(`⚠️  Data quality issues: ${totalIssues}`);
  
  if (errorCount === 0 && totalIssues === 0) {
    console.log('\n🎉 All tests passed! Issues appear to be fixed.');
  } else if (errorCount === 0 && totalIssues < 3) {
    console.log('\n✅ Endpoints working, minor data quality issues remain.');
  } else {
    console.log('\n❌ Some issues still need to be addressed.');
  }
  
  process.exit(0);
}

main().catch(error => {
  console.error('Test script failed:', error);
  process.exit(1);
}); 