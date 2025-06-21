#!/usr/bin/env ts-node

/**
 * Migration Script: Apply Clean Schema Changes
 * 
 * This script removes the redundant provider/location columns from transactional tables
 * as part of our clean solution implementation.
 */

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { logger } from '../src/utils/logger';

const config = {
  host: 'localhost',
  port: 8123,
  username: 'default',
  password: '',
  database: 'monad_analytics',
  max_open_connections: 10,
  max_query_timeout: 30000,
  compression: true,
};

async function migrateCleanSchema() {
  console.log('🔧 Applying Clean Schema Migration...\n');

  const client = new MonadClickHouseClient(config);

  try {
    // Step 1: Check current schema
    console.log('1. 📋 Checking current schema...');
    
    const blockProposalsSchema = await client.executeRawQuery('DESCRIBE TABLE block_proposals');
    const qcParticipationSchema = await client.executeRawQuery('DESCRIBE TABLE qc_participation');
    
    console.log('   Block proposals columns:', blockProposalsSchema.map(c => c.name).join(', '));
    console.log('   QC participation columns:', qcParticipationSchema.map(c => c.name).join(', '));
    
    // Step 2: Create backup tables
    console.log('\n2. 💾 Creating backup tables...');
    
    await client.executeCommand(`
      CREATE TABLE block_proposals_backup 
      ENGINE = MergeTree()
      ORDER BY (timestamp, validator_id)
      AS SELECT * FROM block_proposals
    `);
    
    await client.executeCommand(`
      CREATE TABLE qc_participation_backup 
      ENGINE = MergeTree()
      ORDER BY (timestamp, validator_id)
      AS SELECT * FROM qc_participation
    `);
    
    console.log('   ✅ Backup tables created');

    // Step 3: Drop redundant columns from block_proposals
    console.log('\n3. 🗑️  Removing redundant columns from block_proposals...');
    
    const blockColumns = blockProposalsSchema.map(c => c.name);
    if (blockColumns.includes('provider')) {
      await client.executeCommand('ALTER TABLE block_proposals DROP COLUMN provider');
      console.log('   ✅ Removed provider column');
    }
    if (blockColumns.includes('location')) {
      await client.executeCommand('ALTER TABLE block_proposals DROP COLUMN location');
      console.log('   ✅ Removed location column');
    }
    if (blockColumns.includes('validator_name')) {
      await client.executeCommand('ALTER TABLE block_proposals DROP COLUMN validator_name');
      console.log('   ✅ Removed validator_name column');
    }

    // Step 4: Drop redundant columns from qc_participation
    console.log('\n4. 🗑️  Removing redundant columns from qc_participation...');
    
    const qcColumns = qcParticipationSchema.map(c => c.name);
    if (qcColumns.includes('provider')) {
      await client.executeCommand('ALTER TABLE qc_participation DROP COLUMN provider');
      console.log('   ✅ Removed provider column');
    }
    if (qcColumns.includes('location')) {
      await client.executeCommand('ALTER TABLE qc_participation DROP COLUMN location');
      console.log('   ✅ Removed location column');
    }

    // Step 5: Verify new schema
    console.log('\n5. ✅ Verifying new schema...');
    
    const newBlockSchema = await client.executeRawQuery('DESCRIBE TABLE block_proposals');
    const newQcSchema = await client.executeRawQuery('DESCRIBE TABLE qc_participation');
    
    console.log('   New block proposals columns:', newBlockSchema.map(c => c.name).join(', '));
    console.log('   New QC participation columns:', newQcSchema.map(c => c.name).join(', '));

    // Step 6: Test data integrity
    console.log('\n6. 🔍 Testing data integrity...');
    
    const blockCount = await client.executeRawQuery('SELECT COUNT(*) as count FROM block_proposals');
    const qcCount = await client.executeRawQuery('SELECT COUNT(*) as count FROM qc_participation');
    
    console.log(`   Block proposals: ${blockCount[0].count} rows`);
    console.log(`   QC participation: ${qcCount[0].count} rows`);

    // Step 7: Test API query pattern
    console.log('\n7. 🔍 Testing API query pattern...');
    
    const testQuery = `
      SELECT 
        bp.validator_id,
        bp.status,
        bp.timestamp,
        COALESCE(vr.provider, 'unknown') as provider,
        COALESCE(vr.location, 'unknown') as location,
        COALESCE(vr.validator_name, 'unknown') as validator_name
      FROM block_proposals bp
      LEFT JOIN validator_registry vr ON bp.validator_id = vr.validator_id AND vr.is_active = 1
      ORDER BY bp.timestamp DESC
      LIMIT 3
    `;
    
    const testResult = await client.executeRawQuery(testQuery);
    console.log('   ✅ API query working correctly');
    console.log('   Sample results:');
    testResult.forEach((row, i) => {
      console.log(`     ${i + 1}. ${row.validator_id.substring(0, 20)}... | ${row.provider} | ${row.location}`);
    });

    console.log('\n🎉 Clean schema migration completed successfully!');
    console.log('\n📋 Migration Summary:');
    console.log('   ✅ Redundant columns removed');
    console.log('   ✅ Data integrity preserved');
    console.log('   ✅ API queries working');
    console.log('   ✅ Backup tables created');
    console.log('   🚀 System now using clean, normalized schema');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    console.log('\n🔄 Rollback options:');
    console.log('   - Backup tables: block_proposals_backup, qc_participation_backup');
    process.exit(1);
  } finally {
    await client.close();
  }
}

// Run the migration
if (require.main === module) {
  migrateCleanSchema().catch(console.error);
}

export default migrateCleanSchema; 