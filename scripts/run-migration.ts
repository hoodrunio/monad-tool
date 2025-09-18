#!/usr/bin/env ts-node

import dotenv from 'dotenv';
import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { MigrationRunner } from '../src/database/migration-runner';
import { logger } from '../src/utils/logger';

// Load environment variables
dotenv.config();

async function runMigration() {
  const clickhouseClient = new MonadClickHouseClient({
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DB || 'monad_analytics',
    max_open_connections: 10,
    max_query_timeout: 30000,
    compression: true
  });

  try {
    const migrationRunner = new MigrationRunner(clickhouseClient);
    
    const args = process.argv.slice(2);
    const migrationFile = args[0];
    
    if (!migrationFile) {
      logger.error('Usage: npm run migrate <migration_file>');
      logger.error('Example: npm run migrate 002_add_staking_columns.sql');
      process.exit(1);
    }
    
    await migrationRunner.runMigration(migrationFile);
    logger.info('🎉 Migration completed successfully');
    
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await clickhouseClient.close();
  }
}

runMigration();
