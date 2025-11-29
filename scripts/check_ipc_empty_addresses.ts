#!/usr/bin/env tsx

import { MonadIpcClient } from '../src/services/ipc/MonadIpcClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const socketPath = process.env.IPC_SOCKET_PATH || '/home/monad/monad-bft/controlpanel.sock';

  console.log('🔍 Checking IPC peers for empty addresses...\n');

  const client = new MonadIpcClient(socketPath);
  const peers = await client.getPeers();

  const withIp = peers.filter(p => p.addr && p.addr.trim() !== '');
  const withoutIp = peers.filter(p => !p.addr || p.addr.trim() === '');

  console.log('📊 Results:');
  console.log('─'.repeat(60));
  console.log(`Total peers from IPC:     ${peers.length}`);
  console.log(`Peers WITH IP address:    ${withIp.length} ✅`);
  console.log(`Peers WITHOUT IP address: ${withoutIp.length} ❌`);
  console.log('─'.repeat(60));

  if (withoutIp.length > 0) {
    console.log('\n❌ Sample peers WITHOUT IP address:');
    withoutIp.slice(0, 10).forEach((p, i) => {
      console.log(`   ${i + 1}. Pubkey: ${p.pubkey.substring(0, 20)}... → addr: "${p.addr}"`);
    });
  }

  if (withIp.length > 0) {
    console.log('\n✅ Sample peers WITH IP address:');
    withIp.slice(0, 5).forEach((p, i) => {
      console.log(`   ${i + 1}. Pubkey: ${p.pubkey.substring(0, 20)}... → addr: ${p.addr}`);
    });
  }

  console.log('\n📝 Summary:');
  const missingPercent = ((withoutIp.length / peers.length) * 100).toFixed(1);
  console.log(`   ${missingPercent}% of validators from IPC have no IP address`);

  if (withoutIp.length > 0) {
    console.log(`\n⚠️  These ${withoutIp.length} validators cannot be geo-located because`);
    console.log('   they have no IP address in the IPC response.');
  }
}

main().catch(console.error);
