/**
 * Migration: Rebuild validator_registry_latest with full schema
 *
 * This migration fixes the validator_registry_latest table to include
 * all missing columns from validator_registry (dns_address, dns_host, dns_port, node_id, etc.)
 */

import { ClickHouseClient } from '@clickhouse/client';
import { Migration } from './Migration';

export class RebuildValidatorRegistryLatestMigration implements Migration {
  id = '20251116000001';
  name = 'Rebuild validator_registry_latest with full schema';

  async shouldRun(client: ClickHouseClient, database: string): Promise<boolean> {
    try {
      // Check if dns_address column exists in validator_registry_latest
      const checkColumn = await client.query({
        query: `
          SELECT name
          FROM system.columns
          WHERE database = '${database}'
            AND table = 'validator_registry_latest'
            AND name = 'dns_address'
        `,
        format: 'JSONEachRow'
      });

      const result = await checkColumn.json() as any[];

      // If column doesn't exist, migration should run
      return result.length === 0;
    } catch (error) {
      // If table doesn't exist yet, migration is not needed
      return false;
    }
  }

  async up(client: ClickHouseClient, database: string): Promise<void> {
    console.log(`  Running migration: ${this.name}`);

    // Drop materialized view first (if exists)
    await client.command({
      query: `DROP VIEW IF EXISTS ${database}.validator_registry_latest_mv`
    });

    // Drop the old table
    await client.command({
      query: `DROP TABLE IF EXISTS ${database}.validator_registry_latest`
    });

    console.log(`  ✅ Dropped old validator_registry_latest table and view`);

    // Create new table with full schema matching validator_registry
    await client.command({
      query: `
        CREATE TABLE ${database}.validator_registry_latest AS ${database}.validator_registry
      `
    });

    console.log(`  ✅ Created new validator_registry_latest table with full schema`);

    // Populate with latest records for each validator
    await client.command({
      query: `
        INSERT INTO ${database}.validator_registry_latest
        SELECT * FROM ${database}.validator_registry
        WHERE (node_id, last_updated) IN (
          SELECT node_id, MAX(last_updated)
          FROM ${database}.validator_registry
          GROUP BY node_id
        )
      `
    });

    console.log(`  ✅ Populated validator_registry_latest with latest records`);

    // Verify
    const countQuery = await client.query({
      query: `SELECT COUNT(*) as count FROM ${database}.validator_registry_latest`,
      format: 'JSONEachRow'
    });
    const countResult = await countQuery.json() as any[];
    const count = countResult[0]?.count || 0;

    console.log(`  ✅ Migration complete: ${count} validators in validator_registry_latest`);
  }
}
