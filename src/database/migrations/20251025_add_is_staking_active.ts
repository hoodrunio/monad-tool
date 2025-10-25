/**
 * Migration: Add is_staking_active column to validator_registry_latest
 *
 * This migration fixes the validator_registry_latest table to include
 * the is_staking_active column which is required by consensus APIs.
 */

import { ClickHouseClient } from '@clickhouse/client';
import { Migration } from './Migration';

export class AddIsStakingActiveMigration implements Migration {
  id = '20251025000001';
  name = 'Add is_staking_active column to validator_registry_latest';

  async shouldRun(client: ClickHouseClient, database: string): Promise<boolean> {
    try {
      const checkColumn = await client.query({
        query: `
          SELECT name
          FROM system.columns
          WHERE database = '${database}'
            AND table = 'validator_registry_latest'
            AND name = 'is_staking_active'
        `,
        format: 'JSONEachRow'
      });

      const result = await checkColumn.json() as any[];

      // If column doesn't exist, migration should run
      return result.length === 0;
    } catch (error) {
      // If table doesn't exist yet, migration is not needed
      // (table will be created with correct schema)
      return false;
    }
  }

  async up(client: ClickHouseClient, database: string): Promise<void> {
    console.log(`  Running migration: ${this.name}`);

    // Drop materialized view first (depends on the table)
    await client.command({
      query: `DROP VIEW IF EXISTS ${database}.validator_registry_latest_mv`
    });

    // Drop and recreate the table with new schema
    await client.command({
      query: `DROP TABLE IF EXISTS ${database}.validator_registry_latest`
    });

    console.log(`  ✅ Dropped old validator_registry_latest table and view`);
    console.log(`  ℹ️  New schema will be created by initializeSchema()`);
  }
}
