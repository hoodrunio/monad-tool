#!/usr/bin/env ts-node

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { logger } from '../src/utils/logger';

async function debugValidatorCounts() {
  const client = new MonadClickHouseClient({
    host: 'localhost',
    port: 8123,
    username: 'default',
    password: '',
    database: 'monad_analytics',
    max_open_connections: 20,
    max_query_timeout: 60000,
    compression: true
  });
  
  try {
    console.log('🔍 Debugging Validator Count Issue in Rankings Endpoint\n');

    // 1. Check total validators in validator_registry
    console.log('1️⃣ VALIDATOR REGISTRY STATUS:');
    const registryQuery = `
      SELECT 
        COUNT(*) as total_validators,
        COUNT(CASE WHEN is_active = 1 THEN 1 END) as active_validators,
        COUNT(CASE WHEN is_active = 0 THEN 1 END) as inactive_validators,
        groupArray(DISTINCT epoch) as epochs
      FROM validator_registry
    `;
    const registryResult = await client.executeRawQuery(registryQuery);
    console.log('Registry stats:', registryResult[0]);

    // 2. Check unique validators in block_proposals (last 7 days)
    console.log('\n2️⃣ BLOCK PROPOSALS - UNIQUE VALIDATORS (Last 7 days):');
    const blockProposals7dQuery = `
      SELECT 
        COUNT(DISTINCT validator_id) as unique_validators,
        groupArray(DISTINCT epoch) as epochs_seen
      FROM block_proposals
      WHERE timestamp >= now() - INTERVAL 7 DAY
    `;
    const blockProposals7dResult = await client.executeRawQuery(blockProposals7dQuery);
    console.log('Block proposals (7d):', blockProposals7dResult[0]);

    // 3. Check unique validators in qc_participation (last 7 days)
    console.log('\n3️⃣ QC PARTICIPATION - UNIQUE VALIDATORS (Last 7 days):');
    const qcParticipation7dQuery = `
      SELECT 
        COUNT(DISTINCT validator_id) as unique_validators,
        groupArray(DISTINCT epoch) as epochs_seen
      FROM qc_participation
      WHERE timestamp >= now() - INTERVAL 7 DAY
    `;
    const qcParticipation7dResult = await client.executeRawQuery(qcParticipation7dQuery);
    console.log('QC participation (7d):', qcParticipation7dResult[0]);

    // 4. Check combined unique validators (simulating the rankings query)
    console.log('\n4️⃣ COMBINED UNIQUE VALIDATORS (Simulating Rankings Query):');
    const combinedQuery = `
      WITH 
        block_metrics AS (
          SELECT DISTINCT validator_id
          FROM block_proposals
          WHERE timestamp >= now() - INTERVAL 7 DAY
        ),
        qc_metrics AS (
          SELECT DISTINCT validator_id
          FROM qc_participation
          WHERE timestamp >= now() - INTERVAL 7 DAY
        )
      SELECT 
        COUNT(DISTINCT COALESCE(b.validator_id, q.validator_id)) as total_unique_validators
      FROM block_metrics b
      FULL OUTER JOIN qc_metrics q ON b.validator_id = q.validator_id
    `;
    const combinedResult = await client.executeRawQuery(combinedQuery);
    console.log('Combined unique validators:', combinedResult[0]);

    // 5. Find validators NOT in validator_registry but present in data
    console.log('\n5️⃣ VALIDATORS NOT IN REGISTRY BUT IN DATA:');
    const missingValidatorsQuery = `
      WITH all_validators AS (
        SELECT DISTINCT validator_id FROM block_proposals WHERE timestamp >= now() - INTERVAL 7 DAY
        UNION DISTINCT
        SELECT DISTINCT validator_id FROM qc_participation WHERE timestamp >= now() - INTERVAL 7 DAY
      )
      SELECT 
        av.validator_id,
        MAX(bp.timestamp) as last_block_proposal,
        MAX(qc.timestamp) as last_qc_participation,
        MAX(bp.epoch) as last_block_epoch,
        MAX(qc.epoch) as last_qc_epoch,
        COUNT(DISTINCT bp.timestamp) as block_event_count,
        COUNT(DISTINCT qc.timestamp) as qc_event_count
      FROM all_validators av
      LEFT JOIN validator_registry vr ON av.validator_id = vr.validator_id AND vr.is_active = 1
      LEFT JOIN block_proposals bp ON av.validator_id = bp.validator_id AND bp.timestamp >= now() - INTERVAL 7 DAY
      LEFT JOIN qc_participation qc ON av.validator_id = qc.validator_id AND qc.timestamp >= now() - INTERVAL 7 DAY
      WHERE vr.validator_id IS NULL
      GROUP BY av.validator_id
      ORDER BY qc_event_count DESC, block_event_count DESC
      LIMIT 30
    `;
    const missingValidators = await client.executeRawQuery(missingValidatorsQuery);
    console.log(`Found ${missingValidators.length} validators not in registry but in data:`);
    missingValidators.forEach((v, i) => {
      console.log(`  ${i + 1}. "${v.validator_id || 'NULL/EMPTY'}" (Length: ${v.validator_id?.length || 0})`);
      console.log(`     Last block: ${v.last_block_proposal || 'never'} (epoch ${v.last_block_epoch || 'N/A'})`);
      console.log(`     Last QC: ${v.last_qc_participation || 'never'} (epoch ${v.last_qc_epoch || 'N/A'})`);
      console.log(`     Events: ${v.block_event_count || 0} blocks, ${v.qc_event_count || 0} QCs`);
    });

    // 5.1. Get some sample validator_ids from recent data to see the format
    console.log('\n5️⃣a SAMPLE VALIDATOR IDs FROM RECENT DATA:');
    const sampleValidatorQuery = `
      SELECT DISTINCT 
        validator_id,
        length(validator_id) as id_length,
        epoch
      FROM qc_participation 
      WHERE timestamp >= now() - INTERVAL 24 HOUR
      ORDER BY timestamp DESC
      LIMIT 10
    `;
    const sampleValidators = await client.executeRawQuery(sampleValidatorQuery);
    console.log('Sample validator IDs from recent QC data:');
    sampleValidators.forEach((v, i) => {
      console.log(`  ${i + 1}. "${v.validator_id}" (Length: ${v.id_length}, Epoch: ${v.epoch})`);
    });

    // 6. Check epoch distribution in recent data
    console.log('\n6️⃣ EPOCH DISTRIBUTION IN RECENT DATA:');
    const epochDistributionQuery = `
      WITH combined_epochs AS (
        SELECT epoch, COUNT(DISTINCT validator_id) as validators FROM block_proposals 
        WHERE timestamp >= now() - INTERVAL 7 DAY 
        GROUP BY epoch
        UNION ALL
        SELECT epoch, COUNT(DISTINCT validator_id) as validators FROM qc_participation 
        WHERE timestamp >= now() - INTERVAL 7 DAY 
        GROUP BY epoch
      )
      SELECT 
        epoch,
        MAX(validators) as max_validators_seen
      FROM combined_epochs
      GROUP BY epoch
      ORDER BY epoch DESC
    `;
    const epochDistribution = await client.executeRawQuery(epochDistributionQuery);
    console.log('Epochs in recent data:');
    epochDistribution.forEach(e => {
      console.log(`  Epoch ${e.epoch}: ${e.max_validators_seen} validators`);
    });

    // 7. Test the actual count query used in rankings
    console.log('\n7️⃣ ACTUAL RANKINGS COUNT QUERY (24h):');
    const actualCountQuery = `
      WITH 
        block_metrics AS (
          SELECT validator_id
          FROM block_proposals
          WHERE timestamp >= now() - INTERVAL 24 HOUR
          GROUP BY validator_id
        ),
        qc_metrics AS (
          SELECT validator_id
          FROM qc_participation
          WHERE timestamp >= now() - INTERVAL 24 HOUR
          GROUP BY validator_id
        )
      SELECT COUNT(DISTINCT COALESCE(b.validator_id, q.validator_id)) as total_count
      FROM block_metrics b
      FULL OUTER JOIN qc_metrics q ON b.validator_id = q.validator_id
      WHERE COALESCE(b.validator_id, q.validator_id) IS NOT NULL
    `;
    const actualCount24h = await client.executeRawQuery(actualCountQuery);
    console.log('24h validator count:', actualCount24h[0]);

    // 8. Same for 7 days
    console.log('\n8️⃣ ACTUAL RANKINGS COUNT QUERY (7d):');
    const actualCount7dQuery = `
      WITH 
        block_metrics AS (
          SELECT validator_id
          FROM block_proposals
          WHERE timestamp >= now() - INTERVAL 7 DAY
          GROUP BY validator_id
        ),
        qc_metrics AS (
          SELECT validator_id
          FROM qc_participation
          WHERE timestamp >= now() - INTERVAL 7 DAY
          GROUP BY validator_id
        )
      SELECT COUNT(DISTINCT COALESCE(b.validator_id, q.validator_id)) as total_count
      FROM block_metrics b
      FULL OUTER JOIN qc_metrics q ON b.validator_id = q.validator_id
      WHERE COALESCE(b.validator_id, q.validator_id) IS NOT NULL
    `;
    const actualCount7d = await client.executeRawQuery(actualCount7dQuery);
    console.log('7d validator count:', actualCount7d[0]);

    console.log('\n✅ Debug completed');
    
  } catch (error) {
    logger.error('Debug failed:', error);
    console.error('❌ Debug failed:', error);
  } finally {
    await client.close();
  }
}

// Run if called directly
if (require.main === module) {
  debugValidatorCounts()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
} 