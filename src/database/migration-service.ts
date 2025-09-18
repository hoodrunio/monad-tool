// Database Migration Service
// Handles schema migrations for production deployments

import { MonadClickHouseClient } from './clickhouse-client';
import { logger } from '../utils/logger';
import fs from 'fs/promises';
import path from 'path';

export interface Migration {
  id: string;
  filename: string;
  description: string;
  sql: string;
}

export class DatabaseMigrationService {
  constructor(private clickhouseClient: MonadClickHouseClient) {}

  /**
   * Run all pending migrations
   */
  async runMigrations(): Promise<void> {
    try {
      logger.info('🔄 Starting database migrations...');
      
      // Ensure migrations table exists
      await this.createMigrationsTable();
      
      // Get pending migrations
      const pendingMigrations = await this.getPendingMigrations();
      
      if (pendingMigrations.length === 0) {
        logger.info('✅ No pending migrations found');
        return;
      }

      logger.info(`📋 Found ${pendingMigrations.length} pending migrations`);
      
      // Execute each migration
      for (const migration of pendingMigrations) {
        await this.executeMigration(migration);
      }
      
      logger.info('✅ All migrations completed successfully');
    } catch (error) {
      logger.error('Failed to run migrations:', error);
      throw error;
    }
  }

  /**
   * Create migrations tracking table
   */
  private async createMigrationsTable(): Promise<void> {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id String,
        filename String,
        description String,
        executed_at DateTime64(3, 'UTC') DEFAULT now()
      ) ENGINE = MergeTree()
      ORDER BY executed_at
      SETTINGS index_granularity = 8192
    `;
    
    await this.clickhouseClient.executeCommand(createTableSQL);
  }

  /**
   * Get list of pending migrations
   */
  private async getPendingMigrations(): Promise<Migration[]> {
    // Get executed migrations
    const executedMigrations = await this.clickhouseClient.executeRawQuery(
      'SELECT id FROM schema_migrations ORDER BY executed_at'
    );
    const executedIds = new Set(executedMigrations.map((row: any) => row.id));

    // Get all migration files
    const migrationsDir = path.join(__dirname, '../../database/migrations');
    const migrationFiles = await fs.readdir(migrationsDir);
    
    const pendingMigrations: Migration[] = [];
    
    for (const filename of migrationFiles.sort()) {
      if (!filename.endsWith('.sql')) continue;
      
      const migrationId = filename.replace('.sql', '');
      if (executedIds.has(migrationId)) continue;
      
      const filePath = path.join(migrationsDir, filename);
      const sql = await fs.readFile(filePath, 'utf-8');
      
      // Extract description from SQL comment
      const descriptionMatch = sql.match(/-- Description: (.+)/);
      const description = descriptionMatch ? descriptionMatch[1] : 'No description';
      
      pendingMigrations.push({
        id: migrationId,
        filename,
        description,
        sql
      });
    }
    
    return pendingMigrations;
  }

  /**
   * Execute a single migration
   */
  private async executeMigration(migration: Migration): Promise<void> {
    logger.info(`🔧 Executing migration: ${migration.id} - ${migration.description}`);
    
    try {
      // Execute migration SQL
      const statements = migration.sql
        .split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));
      
      for (const statement of statements) {
        if (statement.trim()) {
          await this.clickhouseClient.executeCommand(statement);
        }
      }
      
      // Record migration as executed
      await this.clickhouseClient.executeCommand(`
        INSERT INTO schema_migrations (id, filename, description)
        VALUES ('${migration.id}', '${migration.filename}', '${migration.description}')
      `);
      
      logger.info(`✅ Migration completed: ${migration.id}`);
    } catch (error) {
      logger.error(`❌ Migration failed: ${migration.id}`, error);
      throw error;
    }
  }

  /**
   * Check if staking columns exist (for backward compatibility)
   */
  async hasStakingColumns(): Promise<boolean> {
    try {
      const result = await this.clickhouseClient.executeRawQuery(`
        SELECT name 
        FROM system.columns 
        WHERE table = 'validator_registry' 
        AND database = '${this.clickhouseClient.getConfig().database}'
        AND name IN ('precompile_validator_id', 'is_staking_active', 'real_time_stake_wei')
      `);
      
      return result.length >= 3;
    } catch (error) {
      logger.warn('Failed to check staking columns:', error);
      return false;
    }
  }
}
