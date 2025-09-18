import fs from 'fs';
import path from 'path';
import { MonadClickHouseClient } from './clickhouse-client';
import { logger } from '../utils/logger';

export class MigrationRunner {
  constructor(private clickhouseClient: MonadClickHouseClient) {}

  /**
   * Run a specific migration file
   */
  async runMigration(migrationFile: string): Promise<void> {
    const migrationPath = path.join(__dirname, '../../database/migrations', migrationFile);
    
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Migration file not found: ${migrationFile}`);
    }

    try {
      logger.info(`🔄 Running migration: ${migrationFile}`);
      
      const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');
      
      // Split by statements (semicolon + newline)
      const statements = migrationSQL
        .split(';\n')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

      for (const statement of statements) {
        if (statement.trim()) {
          await this.clickhouseClient.executeCommand(statement);
        }
      }

      logger.info(`✅ Migration completed: ${migrationFile}`);
    } catch (error) {
      logger.error(`❌ Migration failed: ${migrationFile}`, error);
      throw error;
    }
  }

  /**
   * Check if migration is needed by testing for new columns
   */
  async isMigrationNeeded(): Promise<boolean> {
    try {
      const result = await this.clickhouseClient.executeRawQuery(`
        SELECT count() as has_column 
        FROM system.columns 
        WHERE table = 'validator_registry' 
        AND name = 'precompile_validator_id'
      `);
      
      return result[0]?.has_column === 0;
    } catch (error) {
      logger.warn('Failed to check migration status:', error);
      return true; // Assume migration needed if check fails
    }
  }

  /**
   * Run migration if needed
   */
  async runMigrationIfNeeded(): Promise<void> {
    const needsMigration = await this.isMigrationNeeded();
    
    if (needsMigration) {
      logger.info('🔄 Database migration needed, applying schema changes...');
      await this.runMigration('002_add_staking_columns.sql');
    } else {
      logger.info('✅ Database schema is up to date');
    }
  }
}
