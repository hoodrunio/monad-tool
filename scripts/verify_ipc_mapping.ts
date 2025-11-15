#!/usr/bin/env tsx

/**
 * IPC vs Database Mapping Verification Script
 *
 * This script verifies that IPC pubkeys are correctly mapped to database node_ids
 * and identifies any mismatches or normalization issues.
 */

import { MonadIpcClient } from '../src/services/ipc/MonadIpcClient.js';
import { MonadClickHouseClient } from '../src/database/clickhouse-client.js';
import dotenv from 'dotenv';

dotenv.config();

interface ValidationResult {
  ipcPeers: number;
  dbValidators: number;
  matched: number;
  onlyInIpc: number;
  onlyInDb: number;
  ipcPubkeys: Set<string>;
  dbNodeIds: Set<string>;
  matchedIds: Set<string>;
  onlyIpcIds: Set<string>;
  onlyDbIds: Set<string>;
}

function normalizeNodeId(nodeId: string): string {
  // Remove 0x prefix if present and convert to lowercase
  return nodeId.startsWith('0x') ? nodeId.slice(2).toLowerCase() : nodeId.toLowerCase();
}

async function getIpcPubkeys(): Promise<Set<string>> {
  const socketPath = process.env.IPC_SOCKET_PATH || '/home/monad/monad-bft/controlpanel.sock';
  console.log(`📡 Connecting to IPC socket: ${socketPath}`);

  const ipcClient = new MonadIpcClient(socketPath);
  const peers = await ipcClient.getPeers();

  console.log(`✅ Retrieved ${peers.length} peers from IPC`);

  const pubkeys = new Set<string>();
  for (const peer of peers) {
    const normalized = normalizeNodeId(peer.pubkey);
    pubkeys.add(normalized);
  }

  return pubkeys;
}

async function getDbNodeIds(): Promise<Set<string>> {
  const clickhouseClient = new MonadClickHouseClient({
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    maxConnections: 10,
    queryTimeout: 30000,
    compression: true
  });

  console.log(`🗄️  Connecting to ClickHouse...`);

  const query = `SELECT DISTINCT node_id FROM validator_registry WHERE node_id != ''`;
  const result = await clickhouseClient.query(query);

  console.log(`✅ Retrieved ${result.length} unique node_ids from database`);

  const nodeIds = new Set<string>();
  for (const row of result) {
    const normalized = normalizeNodeId(row.node_id);
    nodeIds.add(normalized);
  }

  await clickhouseClient.close();

  return nodeIds;
}

function analyzeMapping(ipcPubkeys: Set<string>, dbNodeIds: Set<string>): ValidationResult {
  const matchedIds = new Set<string>();
  const onlyIpcIds = new Set<string>();
  const onlyDbIds = new Set<string>();

  // Find matches and IPC-only
  for (const pubkey of ipcPubkeys) {
    if (dbNodeIds.has(pubkey)) {
      matchedIds.add(pubkey);
    } else {
      onlyIpcIds.add(pubkey);
    }
  }

  // Find DB-only
  for (const nodeId of dbNodeIds) {
    if (!ipcPubkeys.has(nodeId)) {
      onlyDbIds.add(nodeId);
    }
  }

  return {
    ipcPeers: ipcPubkeys.size,
    dbValidators: dbNodeIds.size,
    matched: matchedIds.size,
    onlyInIpc: onlyIpcIds.size,
    onlyInDb: onlyDbIds.size,
    ipcPubkeys,
    dbNodeIds,
    matchedIds,
    onlyIpcIds,
    onlyDbIds
  };
}

function printResults(result: ValidationResult): void {
  console.log('\n' + '='.repeat(60));
  console.log('📊 IPC vs Database Mapping Analysis');
  console.log('='.repeat(60));
  console.log();

  console.log(`📡 IPC Peers:              ${result.ipcPeers}`);
  console.log(`🗄️  Database Validators:    ${result.dbValidators}`);
  console.log(`✅ Matched:                ${result.matched} (${((result.matched / result.ipcPeers) * 100).toFixed(1)}%)`);
  console.log(`🆕 Only in IPC:            ${result.onlyInIpc}`);
  console.log(`🗑️  Only in Database:       ${result.onlyInDb}`);
  console.log();

  if (result.onlyInIpc > 0) {
    console.log('❌ Sample validators ONLY in IPC (not in database):');
    const samples = Array.from(result.onlyIpcIds).slice(0, 5);
    samples.forEach((pubkey, i) => {
      console.log(`   ${i + 1}. ${pubkey}`);
    });
    console.log();
  }

  if (result.onlyInDb > 0) {
    console.log('⚠️  Sample validators ONLY in Database (not in IPC):');
    const samples = Array.from(result.onlyDbIds).slice(0, 5);
    samples.forEach((nodeId, i) => {
      console.log(`   ${i + 1}. ${nodeId}`);
    });
    console.log();
  }

  console.log('='.repeat(60));

  // Analysis
  if (result.matched === result.ipcPeers) {
    console.log('✅ PERFECT: All IPC peers are mapped to database!');
  } else {
    console.log('⚠️  WARNING: Some IPC peers are NOT in database!');
    console.log(`   → ${result.onlyInIpc} validators from IPC need to be added to database`);
  }

  if (result.onlyInDb > 0) {
    console.log(`ℹ️  INFO: ${result.onlyInDb} validators in database are not currently connected (not in IPC)`);
  }

  console.log('='.repeat(60));
}

async function main() {
  try {
    console.log('🚀 Starting IPC vs Database Mapping Verification...\n');

    const [ipcPubkeys, dbNodeIds] = await Promise.all([
      getIpcPubkeys(),
      getDbNodeIds()
    ]);

    const result = analyzeMapping(ipcPubkeys, dbNodeIds);
    printResults(result);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
