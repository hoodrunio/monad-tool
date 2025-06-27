#!/usr/bin/env ts-node

// Problem Token Analysis - 0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714
// Bu token neden "execution reverted" veriyor anlayalım

import axios from 'axios';

const RPC_URL = process.env.RPC_MONAD_HTTP || 'https://testnet-rpc.monad.xyz';
const PROBLEM_TOKEN = '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714';
const BLOCK_NUMBER = '0x1688cb9'; // 23628985 from logs

interface RpcResponse {
  jsonrpc: string;
  id: string;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

async function makeRpcCall(method: string, params: any[]): Promise<RpcResponse> {
  const payload = {
    jsonrpc: '2.0',
    method,
    params,
    id: Date.now().toString()
  };

  const response = await axios.post(RPC_URL, payload, {
    timeout: 10000,
    headers: { 'Content-Type': 'application/json' }
  });
  return response.data;
}

async function testContractCall(description: string, data: string): Promise<void> {
  console.log(`\n🧪 Testing: ${description}`);
  console.log(`   Data: ${data}`);
  
  try {
    const response = await makeRpcCall('eth_call', [
      { to: PROBLEM_TOKEN, data },
      BLOCK_NUMBER
    ]);

    if (response.error) {
      console.log(`   ❌ ERROR: ${response.error.message} (Code: ${response.error.code})`);
      
      // "execution reverted" NORMAL bir cevap olabilir!
      if (response.error.code === -32603 && response.error.message.includes('execution reverted')) {
        console.log(`   ℹ️  Bu normal: Contract bu method'u desteklemiyor`);
      }
    } else {
      console.log(`   ✅ SUCCESS: ${response.result}`);
      
      // Result'u decode edelim
      if (data === '0x06fdde03') { // name()
        console.log(`   📝 Decoded: Contract name found`);
      } else if (data === '0x95d89b41') { // symbol()
        console.log(`   🏷️  Decoded: Contract symbol found`);
      } else if (data === '0x313ce567') { // decimals()
        const decimals = parseInt(response.result, 16);
        console.log(`   🔢 Decoded: ${decimals} decimals`);
      } else if (data === '0x18160ddd') { // totalSupply()
        console.log(`   📊 Decoded: Total supply found`);
      }
    }
  } catch (error) {
    console.log(`   💥 NETWORK ERROR: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}

async function analyzeToken(): Promise<void> {
  console.log('🔍 TOKEN INTERFACE ANALYSIS');
  console.log(`🎯 Token: ${PROBLEM_TOKEN}`);
  console.log(`📦 Block: ${BLOCK_NUMBER} (${parseInt(BLOCK_NUMBER, 16)})`);
  console.log('='.repeat(80));

  // 1. Contract code varsa kontrol et
  console.log('\n📋 1. CONTRACT EXISTENCE CHECK:');
  const codeResponse = await makeRpcCall('eth_getCode', [PROBLEM_TOKEN, BLOCK_NUMBER]);
  if (codeResponse.error) {
    console.log(`❌ Code check failed: ${codeResponse.error.message}`);
    return;
  }
  const codeLength = codeResponse.result?.length || 0;
  console.log(`✅ Contract exists, code length: ${codeLength}`);

  // 2. ERC165 Support Check - Bu neden failure veriyor?
  console.log('\n🔌 2. ERC165 INTERFACE CHECKS:');
  await testContractCall('ERC165 supportsInterface(ERC165)', '0x01ffc9a701ffc9a700000000000000000000000000000000000000000000000000000000');
  await testContractCall('ERC165 supportsInterface(ERC20)', '0x01ffc9a736372b0700000000000000000000000000000000000000000000000000000000');
  await testContractCall('ERC165 supportsInterface(ERC721)', '0x01ffc9a780ac58cd00000000000000000000000000000000000000000000000000000000');
  await testContractCall('ERC165 supportsInterface(ERC1155)', '0x01ffc9a7d9b67a2600000000000000000000000000000000000000000000000000000000');

  // 3. Direct Method Calls - Bunlar çalışıyor mu?
  console.log('\n🏷️  3. DIRECT METHOD CALLS:');
  await testContractCall('name()', '0x06fdde03');
  await testContractCall('symbol()', '0x95d89b41');
  await testContractCall('decimals()', '0x313ce567');
  await testContractCall('totalSupply()', '0x18160ddd');

  // 4. ERC721 specific methods
  console.log('\n🎨 4. ERC721 SPECIFIC METHODS:');
  await testContractCall('tokenURI(0)', '0xc87b56dd0000000000000000000000000000000000000000000000000000000000000000');
  await testContractCall('ownerOf(1)', '0x6352211e0000000000000000000000000000000000000000000000000000000000000001');

  // 5. ERC1155 specific methods  
  console.log('\n🎭 5. ERC1155 SPECIFIC METHODS:');
  await testContractCall('uri(0)', '0x0e89341c0000000000000000000000000000000000000000000000000000000000000000');

  console.log('\n' + '='.repeat(80));
  console.log('🎯 ANALIZ SONUCU:');
  console.log('• "execution reverted" = Normal cevap (method desteklenmiyor)');
  console.log('• Bu hata olarak görülmemeli, retry edilmemeli');
  console.log('• Method-based detection daha güvenilir');
  console.log('• ERC165 çoğu token tarafından desteklenmiyor');
  console.log('='.repeat(80));
}

if (require.main === module) {
  analyzeToken().catch(console.error);
} 