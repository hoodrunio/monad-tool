#!/usr/bin/env ts-node

// Simple test to verify database insertion works
import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { EventType } from '../src/log-processor/types';

async function testInsertion() {
  console.log('🧪 Testing ClickHouse insertion...');

  const config = {
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    max_open_connections: 5,
    max_query_timeout: 30000,
    compression: true
  };

  const client = new MonadClickHouseClient(config);

  try {
    // Test with a single simple event
    const testEvent = {
      timestamp: new Date(),
      eventType: EventType.VOTE_ATTEMPT,
      validatorId: 'test_validator_123',
      roundNumber: 12345,
      epochNumber: 1,
      blockNumber: undefined,
      blockId: undefined,
      parentVoteId: undefined,
      parentRound: undefined,
      nextLeaderId: undefined,
      blockTimestampMs: undefined,
      processingTimestampMs: Date.now(),
      processingDelayMs: 100,
      transactionCount: 0,
      stateRootAction: '',
      sequenceNumber: null,
      validatorDns: 'test.example.com',
      geographicRegion: 'test_region',
      infrastructureProvider: 'test_provider',
      datacenterCode: 'test-001',
      isSuccessful: true,
      participantCount: null,
      participationRate: null,
      metadata: '{"test": true}',
      ingestionId: uuidv4()
    };

    console.log('📝 Inserting test event...');
    console.log('Event data:', JSON.stringify(testEvent, null, 2));

    await client.insertValidatorEvents([testEvent as any]);
    console.log('✅ Successfully inserted test event!');

    // Query back to verify
    console.log('🔍 Querying data back...');
    const result = await client['client'].query({
      query: `SELECT * FROM validator_events WHERE validator_id = 'test_validator_123' LIMIT 1`,
      format: 'JSONEachRow'
    });
    
    const rows = await result.json() as any[];
    console.log('📊 Retrieved data:', rows);

    if (rows.length > 0) {
      console.log('🎉 Data insertion and retrieval successful!');
    } else {
      console.log('⚠️ No data found - insertion may have failed');
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await client.close();
  }
}

// Run if called directly
if (require.main === module) {
  testInsertion().catch(console.error);
} 