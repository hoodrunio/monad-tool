#!/usr/bin/env tsx

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { logger } from '../src/utils/logger';

interface TableSample {
  tableName: string;
  rowCount: number;
  sampleData: any[];
  error?: string;
}

class DatabaseSampler {
  private client: MonadClickHouseClient;

  constructor() {
    this.client = new MonadClickHouseClient({
      host: process.env.CLICKHOUSE_HOST || 'localhost',
      port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
      max_open_connections: 10,
      max_query_timeout: 30000,
      compression: true
    });
  }

  async getDatabaseTables(): Promise<string[]> {
    try {
      const query = `
        SELECT name
        FROM system.tables
        WHERE database = '${process.env.CLICKHOUSE_DATABASE || 'monad_analytics'}'
          AND engine LIKE '%MergeTree%'
        ORDER BY name
      `;

      const result = await this.client.executeRawQuery(query);
      return result.map((row: any) => row.name);
    } catch (error) {
      logger.error('Failed to get database tables:', error);
      return [];
    }
  }

  async getTableRowCount(tableName: string): Promise<number> {
    try {
      const query = `SELECT count() as total FROM ${tableName}`;
      const result = await this.client.executeRawQuery(query);
      return result[0]?.total || 0;
    } catch (error) {
      logger.error(`Failed to get row count for ${tableName}:`, error);
      return 0;
    }
  }

  async getTableSample(tableName: string, limit: number = 5): Promise<TableSample> {
    try {
      logger.info(`📊 Sampling ${limit} records from table: ${tableName}`);

      // Get row count first
      const rowCount = await this.getTableRowCount(tableName);

      // Get sample data
      const query = `SELECT * FROM ${tableName} LIMIT ${limit}`;
      const sampleData = await this.client.executeRawQuery(query);

      return {
        tableName,
        rowCount,
        sampleData
      };
    } catch (error) {
      logger.error(`Failed to sample table ${tableName}:`, error);
      return {
        tableName,
        rowCount: 0,
        sampleData: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async getTableSchema(tableName: string): Promise<any[]> {
    try {
      const query = `
        SELECT 
          name,
          type,
          default_kind,
          default_expression,
          comment
        FROM system.columns
        WHERE database = '${process.env.CLICKHOUSE_DATABASE || 'monad_analytics'}'
          AND table = '${tableName}'
        ORDER BY position
      `;

      return await this.client.executeRawQuery(query);
    } catch (error) {
      logger.error(`Failed to get schema for ${tableName}:`, error);
      return [];
    }
  }

  formatSampleData(sample: TableSample): string {
    let output = `\n${'='.repeat(80)}\n`;
    output += `📋 TABLE: ${sample.tableName.toUpperCase()}\n`;
    output += `${'='.repeat(80)}\n`;
    output += `📊 Total Rows: ${sample.rowCount.toLocaleString()}\n`;

    if (sample.error) {
      output += `❌ Error: ${sample.error}\n`;
      return output;
    }

    if (sample.sampleData.length === 0) {
      output += `📭 No data found in table\n`;
      return output;
    }

    output += `📄 Sample Data (${sample.sampleData.length} records):\n`;
    output += `${'-'.repeat(80)}\n`;

    // Display each record
    sample.sampleData.forEach((record, index) => {
      output += `\n🔢 Record ${index + 1}:\n`;
      
      // Format each field
      Object.entries(record).forEach(([key, value]) => {
        const formattedValue = this.formatValue(value);
        output += `  ${key.padEnd(25)}: ${formattedValue}\n`;
      });
    });

    return output;
  }

  formatValue(value: any): string {
    if (value === null || value === undefined) {
      return '(null)';
    }

    if (typeof value === 'string') {
      // Truncate long strings
      return value.length > 100 ? `"${value.substring(0, 100)}..."` : `"${value}"`;
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  }

  async generateSchemaOverview(tables: string[]): Promise<string> {
    let output = `\n${'='.repeat(80)}\n`;
    output += `🏗️  DATABASE SCHEMA OVERVIEW\n`;
    output += `${'='.repeat(80)}\n`;

    for (const tableName of tables) {
      try {
        const schema = await this.getTableSchema(tableName);
        const rowCount = await this.getTableRowCount(tableName);

        output += `\n📋 ${tableName.toUpperCase()} (${rowCount.toLocaleString()} rows)\n`;
        output += `${'-'.repeat(60)}\n`;

        schema.forEach(column => {
          const typeInfo = `${column.type}${column.default_expression ? ` DEFAULT ${column.default_expression}` : ''}`;
          output += `  ${column.name.padEnd(30)} : ${typeInfo}\n`;
        });
      } catch (error) {
        output += `\n📋 ${tableName.toUpperCase()}\n`;
        output += `  ❌ Error getting schema: ${error}\n`;
      }
    }

    return output;
  }

  async run(): Promise<void> {
    try {
      logger.info('🚀 Starting database sampling...');

      // Test connection
      const isConnected = await this.client.ping();
      if (!isConnected) {
        throw new Error('Failed to connect to ClickHouse database');
      }

      logger.info('✅ Connected to ClickHouse successfully');

      // Get all tables
      const tables = await this.getDatabaseTables();
      
      if (tables.length === 0) {
        logger.warn('⚠️  No tables found in database');
        return;
      }

      logger.info(`📊 Found ${tables.length} tables: ${tables.join(', ')}`);

      // Generate schema overview
      const schemaOverview = await this.generateSchemaOverview(tables);
      console.log(schemaOverview);

      // Sample each table
      const samples: TableSample[] = [];
      
      for (const tableName of tables) {
        const sample = await this.getTableSample(tableName, 5);
        samples.push(sample);
        
        // Display results immediately
        console.log(this.formatSampleData(sample));
      }

      // Generate summary
      this.generateSummary(samples);

    } catch (error) {
      logger.error('❌ Script execution failed:', error);
      process.exit(1);
    } finally {
      await this.client.close();
    }
  }

  generateSummary(samples: TableSample[]): void {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 SAMPLING SUMMARY`);
    console.log(`${'='.repeat(80)}`);

    const totalRows = samples.reduce((sum, sample) => sum + sample.rowCount, 0);
    const tablesWithData = samples.filter(sample => sample.rowCount > 0).length;
    const tablesWithErrors = samples.filter(sample => sample.error).length;

    console.log(`📋 Total Tables: ${samples.length}`);
    console.log(`📊 Tables with Data: ${tablesWithData}`);
    console.log(`📭 Empty Tables: ${samples.length - tablesWithData - tablesWithErrors}`);
    console.log(`❌ Tables with Errors: ${tablesWithErrors}`);
    console.log(`🔢 Total Records: ${totalRows.toLocaleString()}`);

    if (tablesWithErrors > 0) {
      console.log(`\n❌ Errors encountered:`);
      samples
        .filter(sample => sample.error)
        .forEach(sample => {
          console.log(`  - ${sample.tableName}: ${sample.error}`);
        });
    }

    console.log(`\n✅ Database sampling completed successfully!`);
  }
}

// Script execution
async function main(): Promise<void> {
  const sampler = new DatabaseSampler();
  await sampler.run();
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}

export { DatabaseSampler }; 