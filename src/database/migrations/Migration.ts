/**
 * Migration Interface
 *
 * All database migrations must implement this interface.
 */

import { ClickHouseClient } from '@clickhouse/client';

export interface Migration {
  /**
   * Unique migration identifier (use timestamp format: YYYYMMDDHHMMSS)
   */
  id: string;

  /**
   * Human-readable migration name
   */
  name: string;

  /**
   * Execute the migration
   */
  up(client: ClickHouseClient, database: string): Promise<void>;

  /**
   * Check if migration needs to run
   * Returns true if migration should be executed
   */
  shouldRun(client: ClickHouseClient, database: string): Promise<boolean>;
}
