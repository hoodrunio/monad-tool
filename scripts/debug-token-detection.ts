#!/usr/bin/env ts-node

// Manual RPC Testing Script for Token Detection Issues
// Tests the exact same calls that are failing in the logs

import axios from 'axios';

interface RpcResponse {
  jsonrpc: string;
  id: string;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

const RPC_URL = process.env.RPC_MONAD_HTTP || 'https://testnet-rpc.monad.xyz';

// Token addresses from the failing logs
const TEST_TOKENS = [
  '0x7fdf92a43c54171f9c278c67088ca43f2079d09b',
  '0xf817257fed379853cde0fa4f97ab987181b1e5ea', 
  '0x5387c85a4965769f6b0df430638a1388493486f1'
];

// Block numbers from logs
const TEST_BLOCKS = {
  GENESIS: '0x0',
  CURRENT_FROM_LOGS: '0x1687a62', // 23624290 from logs
  LATEST: 'latest'
};

// Method calls from the logs
const TEST_CALLS = {
  // ERC165 supportsInterface (failing)
  ERC165_SUPPORTS_INTERFACE: '0x01ffc9a701ffc9a700000000000000000000000000000000000000000000000000000000',
  
  // ERC1155 uri() (failing)  
  ERC1155_URI: '0x0e89341c0000000000000000000000000000000000000000000000000000000000000000',
  
  // ERC20/721 name() (succeeding)
  NAME: '0x06fdde03',
  
  // ERC20/721 symbol() (succeeding)
  SYMBOL: '0x95d89b41',
  
  // ERC20 decimals() (succeeding)
  DECIMALS: '0x313ce567',
  
  // ERC20 totalSupply() (succeeding)
  TOTAL_SUPPLY: '0x18160ddd'
};

async function makeRpcCall(method: string, params: any[]): Promise<RpcResponse> {
  const payload = {
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now().toString()
  };

  try {
    const response = await axios.post(RPC_URL, payload, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    throw error;
  }
}

async function testEthCall(tokenAddress: string, data: string, blockTag: string): Promise<void> {
  console.log(`\n🔍 Testing: ${tokenAddress.substring(0, 10)}... | Data: ${data.substring(0, 10)}... | Block: ${blockTag}`);
  
  try {
    const response = await makeRpcCall('eth_call', [
      { to: tokenAddress, data },
      blockTag
    ]);

    if (response.error) {
      console.log(`   ❌ ERROR: ${response.error.message} (Code: ${response.error.code})`);
    } else {
      console.log(`   ✅ SUCCESS: ${response.result}`);
    }
  } catch (error) {
    console.log(`   💥 NETWORK ERROR: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}

async function testContractCode(tokenAddress: string, blockTag: string): Promise<void> {
  console.log(`\n📋 Testing eth_getCode: ${tokenAddress.substring(0, 10)}... | Block: ${blockTag}`);
  
  try {
    const response = await makeRpcCall('eth_getCode', [tokenAddress, blockTag]);
    
    if (response.error) {
      console.log(`   ❌ ERROR: ${response.error.message}`);
    } else {
      const codeLength = response.result?.length || 0;
      const hasCode = response.result && response.result !== '0x' && codeLength > 2;
      console.log(`   ${hasCode ? '✅' : '❌'} Code length: ${codeLength}, Has contract: ${hasCode}`);
    }
  } catch (error) {
    console.log(`   💥 NETWORK ERROR: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}

async function getCurrentBlock(): Promise<number> {
  try {
    const response = await makeRpcCall('eth_blockNumber', []);
    const blockHex = response.result;
    const blockNumber = parseInt(blockHex, 16);
    console.log(`📊 Current block: ${blockNumber} (${blockHex})`);
    return blockNumber;
  } catch (error) {
    console.log(`❌ Failed to get current block: ${error}`);
    return 0;
  }
}

async function runSystematicTests(): Promise<void> {
  console.log('🧪 SYSTEMATIC TOKEN DETECTION DEBUGGING');
  console.log(`🌐 RPC Endpoint: ${RPC_URL}`);
  console.log('='.repeat(80));

  // Get current block info
  const currentBlock = await getCurrentBlock();
  
  console.log('\n' + '='.repeat(80));
  console.log('📝 TESTING STRATEGY:');
  console.log('1. Test eth_getCode with different block numbers');
  console.log('2. Test ERC165 calls (currently failing)');
  console.log('3. Test method-based calls (currently working)');
  console.log('4. Compare patterns between failing and working calls');
  console.log('='.repeat(80));

  for (const tokenAddress of TEST_TOKENS) {
    console.log(`\n🎯 TESTING TOKEN: ${tokenAddress}`);
    console.log('-'.repeat(60));

    // Test 1: Contract code existence at different blocks
    console.log('\n📁 CONTRACT CODE TESTS:');
    await testContractCode(tokenAddress, TEST_BLOCKS.GENESIS);
    await testContractCode(tokenAddress, TEST_BLOCKS.CURRENT_FROM_LOGS);
    await testContractCode(tokenAddress, TEST_BLOCKS.LATEST);

    // Test 2: ERC165 interface detection (failing calls)
    console.log('\n🔌 ERC165 INTERFACE TESTS (Currently Failing):');
    await testEthCall(tokenAddress, TEST_CALLS.ERC165_SUPPORTS_INTERFACE, TEST_BLOCKS.GENESIS);
    await testEthCall(tokenAddress, TEST_CALLS.ERC165_SUPPORTS_INTERFACE, TEST_BLOCKS.CURRENT_FROM_LOGS);
    await testEthCall(tokenAddress, TEST_CALLS.ERC165_SUPPORTS_INTERFACE, TEST_BLOCKS.LATEST);

    // Test 3: ERC1155 calls (failing calls)
    console.log('\n🎨 ERC1155 TESTS (Currently Failing):');
    await testEthCall(tokenAddress, TEST_CALLS.ERC1155_URI, TEST_BLOCKS.GENESIS);
    await testEthCall(tokenAddress, TEST_CALLS.ERC1155_URI, TEST_BLOCKS.CURRENT_FROM_LOGS);
    await testEthCall(tokenAddress, TEST_CALLS.ERC1155_URI, TEST_BLOCKS.LATEST);

    // Test 4: Method-based detection (working calls)
    console.log('\n🏷️  METHOD-BASED TESTS (Currently Working):');
    await testEthCall(tokenAddress, TEST_CALLS.NAME, TEST_BLOCKS.CURRENT_FROM_LOGS);
    await testEthCall(tokenAddress, TEST_CALLS.SYMBOL, TEST_BLOCKS.CURRENT_FROM_LOGS);
    await testEthCall(tokenAddress, TEST_CALLS.DECIMALS, TEST_BLOCKS.CURRENT_FROM_LOGS);
    await testEthCall(tokenAddress, TEST_CALLS.TOTAL_SUPPLY, TEST_BLOCKS.CURRENT_FROM_LOGS);

    console.log('\n' + '='.repeat(60));
  }

  console.log('\n🎯 ADDITIONAL TESTS:');
  console.log('-'.repeat(40));

  // Test block availability
  console.log('\n🧱 BLOCK AVAILABILITY TESTS:');
  
  try {
    const genesisResponse = await makeRpcCall('eth_getBlockByNumber', [TEST_BLOCKS.GENESIS, false]);
    console.log(`Genesis block (0x0): ${genesisResponse.error ? '❌ ' + genesisResponse.error.message : '✅ Available'}`);
  } catch (error) {
    console.log(`Genesis block test failed: ${error}`);
  }

  try {
    const logBlockResponse = await makeRpcCall('eth_getBlockByNumber', [TEST_BLOCKS.CURRENT_FROM_LOGS, false]);
    console.log(`Log block (${TEST_BLOCKS.CURRENT_FROM_LOGS}): ${logBlockResponse.error ? '❌ ' + logBlockResponse.error.message : '✅ Available'}`);
  } catch (error) {
    console.log(`Log block test failed: ${error}`);
  }

  // Test with "latest" vs specific block numbers
  console.log('\n🕒 BLOCK PARAMETER COMPARISON:');
  const testToken = TEST_TOKENS[0];
  
  console.log('Testing same call with "latest" vs specific block:');
  await testEthCall(testToken, TEST_CALLS.NAME, 'latest');
  await testEthCall(testToken, TEST_CALLS.NAME, TEST_BLOCKS.CURRENT_FROM_LOGS);
}

async function main(): Promise<void> {
  try {
    await runSystematicTests();
    
    console.log('\n🎯 ANALYSIS SUMMARY:');
    console.log('='.repeat(80));
    console.log('📋 Expected Findings:');
    console.log('• Block 0x0 (genesis) should not be available on Monad testnet');
    console.log('• ERC165 calls fail because they use block 0x0 by default');
    console.log('• Method-based calls work because they use current block');
    console.log('• "Execution reverted" errors are normal for unsupported interfaces');
    console.log('• System retries these expected failures unnecessarily');
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} 