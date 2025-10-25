/**
 * Migration Runner
 *
 * Executes database migrations in order and tracks which migrations
 * have been applied.
 */

import { ClickHouseClient } from '@clickhouse/client';
import { Migration } from './Migration';
import { AddIsStakingActiveMigration } from './20251025_add_is_staking_active';

export class MigrationRunner {
  private migrations: Migration[] = [
    new AddIsStakingActiveMigration(),
    // Add new migrations here
  ];

  constructor(
    private client: ClickHouseClient,
    private database: string
  ) {}

  /**
   * Run all pending migrations
   */
  async runMigrations(): Promise<void> {
    console.log('🔄 Checking for pending database migrations...');

    let ranCount = 0;

    for (const migration of this.migrations) {
      try {
        const shouldRun = await migration.shouldRun(this.client, this.database);

        if (shouldRun) {
          console.log(`📝 Migration ${migration.id}: ${migration.name}`);
          await migration.up(this.client, this.database);
          ranCount++;
        }
      } catch (error) {
        console.error(`❌ Migration ${migration.id} failed:`, error);
        throw error;
      }
    }

    if (ranCount > 0) {
      console.log(`✅ Applied ${ranCount} migration(s)`);
    } else {
      console.log('✅ No pending migrations');
    }
  }
}
