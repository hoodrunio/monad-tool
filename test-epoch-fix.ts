import { createClient } from '@clickhouse/client';
import { NodeRpcClient } from './src/services/blockchain/NodeRpcClient';
import { EnhancedEpochService } from './src/services/epoch/EnhancedEpochService';
import dotenv from 'dotenv';

dotenv.config();

async function testEpochFix() {
  const clickhouse = createClient({
    host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
  });

  const rpcUrl = process.env.RPC_URL || 'https://testnet.monad.xyz';
  const rpcClient = new NodeRpcClient(rpcUrl);

  try {
    console.log('🧪 Testing Epoch Service Fix for Stale Data\n');
    console.log('='.repeat(60));

    // 1. Check what data exists in DB
    console.log('\n📊 Step 1: Checking database state...\n');

    const epochRangeQuery = `
      SELECT
        epoch,
        min(round) as min_round,
        max(round) as max_round,
        count() as block_count
      FROM monad_analytics.block_proposals
      WHERE epoch > 0
      GROUP BY epoch
      ORDER BY epoch DESC
      LIMIT 10
    `;

    const epochRangeResult = await clickhouse.query({
      query: epochRangeQuery,
      format: 'JSONEachRow',
    });

    const epochRanges = await epochRangeResult.json() as Array<{
      epoch: string;
      min_round: string;
      max_round: string;
      block_count: string;
    }>;

    console.log('Latest epochs in database:');
    console.table(epochRanges.map(e => ({
      epoch: e.epoch,
      minRound: e.min_round,
      maxRound: e.max_round,
      blocks: e.block_count,
    })));

    // 2. Check for stale high-round data
    console.log('\n🔍 Step 2: Checking for stale data...\n');

    const highRoundQuery = `
      SELECT
        round,
        seq_num,
        epoch,
        timestamp
      FROM monad_analytics.block_proposals
      WHERE epoch > 0
      ORDER BY round DESC
      LIMIT 5
    `;

    const highRoundResult = await clickhouse.query({
      query: highRoundQuery,
      format: 'JSONEachRow',
    });

    const highRounds = await highRoundResult.json() as Array<{
      round: string;
      seq_num: string;
      epoch: string;
      timestamp: string;
    }>;

    console.log('Highest rounds (sorted by round number):');
    console.table(highRounds.map(r => ({
      round: r.round,
      seqNum: r.seq_num,
      epoch: r.epoch,
      timestamp: new Date(r.timestamp).toISOString(),
    })));

    // 3. Test the new getCurrentRoundInfo logic
    console.log('\n🔧 Step 3: Testing getCurrentRoundInfo() fix...\n');

    // Simulate what the new code does
    const latestEpochQuery = `
      SELECT epoch
      FROM monad_analytics.block_proposals
      WHERE epoch > 0
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    const latestEpochResult = await clickhouse.query({
      query: latestEpochQuery,
      format: 'JSONEachRow',
    });

    const latestEpochRows = await latestEpochResult.json() as Array<{ epoch: string }>;
    const currentEpoch = parseInt(latestEpochRows[0].epoch);

    console.log(`✓ Latest epoch by timestamp: ${currentEpoch}`);

    const filteredQuery = `
      SELECT
        round,
        seq_num,
        timestamp,
        epoch
      FROM monad_analytics.block_proposals
      WHERE epoch >= ${Math.max(1, currentEpoch - 2)}
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    const filteredResult = await clickhouse.query({
      query: filteredQuery,
      format: 'JSONEachRow',
    });

    const filteredRows = await filteredResult.json() as Array<{
      round: string;
      seq_num: string;
      timestamp: string;
      epoch: string;
    }>;

    console.log(`✓ Filtered query (epoch >= ${Math.max(1, currentEpoch - 2)}):`);
    console.log({
      round: parseInt(filteredRows[0].round),
      seqNum: parseInt(filteredRows[0].seq_num),
      epoch: parseInt(filteredRows[0].epoch),
      timestamp: new Date(filteredRows[0].timestamp).toISOString(),
    });

    // 4. Test the actual service
    console.log('\n🚀 Step 4: Testing EnhancedEpochService...\n');

    const epochService = new EnhancedEpochService(clickhouse, rpcClient, 5000);
    const epochInfo = await epochService.getEpochInfo();

    console.log('Epoch Info Result:');
    console.log(JSON.stringify({
      epochId: epochInfo.epochId,
      inEpochDelayPeriod: epochInfo.inEpochDelayPeriod,
      precompileAvailable: epochInfo.precompileAvailable,
      progress: {
        phase: epochInfo.progress.phase,
        percentage: epochInfo.progress.percentage,
        currentRound: epochInfo.progress.currentRound,
        explanation: epochInfo.progress.explanation,
      },
      delayPeriod: epochInfo.delayConfig,
      staleness: epochInfo.staleness,
    }, null, 2));

    // 5. Validation
    console.log('\n✅ Step 5: Validation\n');

    const isValid = epochInfo.progress.currentRound !== null &&
                    epochInfo.progress.currentRound < 10000000; // Reasonable check

    if (isValid) {
      console.log('✅ SUCCESS: Current round is reasonable');
      console.log(`   Current round: ${epochInfo.progress.currentRound}`);
      console.log(`   Expected range: ~${currentEpoch * 5000} (based on epoch ${currentEpoch})`);
    } else {
      console.log('❌ FAILED: Current round seems wrong');
      console.log(`   Current round: ${epochInfo.progress.currentRound}`);
    }

    // Check delay period
    if (epochInfo.inEpochDelayPeriod) {
      const delayValid =
        epochInfo.delayConfig.elapsedDelayRounds !== null &&
        epochInfo.delayConfig.elapsedDelayRounds >= 0 &&
        epochInfo.delayConfig.remainingDelayRounds !== null &&
        epochInfo.delayConfig.remainingDelayRounds >= -100; // Allow small negative for edge cases

      if (delayValid) {
        console.log('✅ SUCCESS: Delay period calculations are reasonable');
        console.log(`   Elapsed: ${epochInfo.delayConfig.elapsedDelayRounds}`);
        console.log(`   Remaining: ${epochInfo.delayConfig.remainingDelayRounds}`);
      } else {
        console.log('❌ FAILED: Delay period calculations seem wrong');
        console.log(`   Elapsed: ${epochInfo.delayConfig.elapsedDelayRounds}`);
        console.log(`   Remaining: ${epochInfo.delayConfig.remainingDelayRounds}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('🎉 Test completed!\n');

  } catch (error) {
    console.error('\n❌ Error during test:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  } finally {
    await clickhouse.close();
  }
}

testEpochFix();
