#!/usr/bin/env tsx

import { DataSource } from 'typeorm';
import { logger } from '../src/utils/logger';
import { DailyStats } from '../src/model/generated';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Check Daily Stats Table Schema
 * Verify the actual database schema vs TypeORM model
 */

async function checkDailyStatsSchema() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'postgres',
    database: process.env.DB_NAME || 'squid',
    entities: [DailyStats],
    synchronize: false,
    logging: true,
  });

  try {
    await dataSource.initialize();
    logger.info('Database connection established');

    // Get table information from database
    const queryRunner = dataSource.createQueryRunner();
    
    // Check if table exists
    const tableExists = await queryRunner.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'daily_stats'
      );
    `);
    
    console.log('🔍 Table exists:', tableExists[0].exists);
    
    if (tableExists[0].exists) {
      // Get column information
      const columns = await queryRunner.query(`
        SELECT column_name, data_type, is_nullable 
        FROM information_schema.columns 
        WHERE table_name = 'daily_stats' 
        ORDER BY ordinal_position;
      `);
      
      console.log('\n📋 Current table columns:');
      columns.forEach((col: any) => {
        console.log(`  - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
      });
      
      // Check TypeORM model expectations
      console.log('\n🏗️  TypeORM model expects:');
      console.log('  - id: string (PK)');
      console.log('  - date: Date (unique)');
      console.log('  - blockCount: number');
      console.log('  - transactionCount: number'); 
      console.log('  - uniqueAddresses: number');
      console.log('  - totalGasUsed: bigint');
      console.log('  - averageGasPrice: bigint');
      console.log('  - totalValue: bigint');
      
      // Try to query the table
      try {
        const count = await queryRunner.query('SELECT COUNT(*) FROM daily_stats');
        console.log(`\n📊 Table has ${count[0].count} rows`);
      } catch (queryError) {
        console.log('\n❌ Error querying table:', queryError instanceof Error ? queryError.message : String(queryError));
      }
    }
    
    await queryRunner.release();
    
  } catch (error) {
    logger.error('❌ Schema check failed', { 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
    console.error(error);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
      logger.info('Database connection closed');
    }
  }
}

// Run the check
checkDailyStatsSchema().catch(console.error); 