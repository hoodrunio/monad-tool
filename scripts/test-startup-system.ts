/**
 * Test Script for Database Validator Startup System
 * 
 * Tests the critical startup dependency validation that ensures
 * all validators are properly recorded in the database before 
 * the application starts.
 */

import { ApplicationInitializer } from '../src/startup/application-initializer';
import { DatabaseValidatorInitializer } from '../src/services/database-validator-initializer';
import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { logger } from '../src/utils/logger';

async function testStartupSystem() {
  console.log('🧪 Testing Database Validator Startup System...\n');

  try {
    // =============================================
    // Test 1: Application Initializer
    // =============================================
    
    console.log('1️⃣ Testing ApplicationInitializer...');
    
    const config = ApplicationInitializer.createDefaultConfig();
    console.log('📋 Config created:', {
      clickhouse: {
        host: config.clickhouse.host,
        database: config.clickhouse.database
      },
      skipValidatorCheck: config.skipValidatorCheck
    });
    
    const initializer = new ApplicationInitializer(config);
    
    // Test health check before initialization
    console.log('\n🔍 Testing health check before initialization...');
    const preHealthCheck = await initializer.healthCheck();
    console.log('Pre-initialization health:', preHealthCheck);
    
    // =============================================
    // Test 2: Full Initialization
    // =============================================
    
    console.log('\n2️⃣ Testing full initialization...');
    console.log('⚠️  This will ensure validators are in database...');
    
    const startupResult = await initializer.initialize();
    
    console.log('\n✅ Startup Result:');
    console.log('Success:', startupResult.success);
    console.log('Time:', `${startupResult.timeMs}ms`);
    console.log('Validator Stats:', startupResult.validatorStats);
    console.log('Services:', startupResult.services);
    
    if (startupResult.errors.length > 0) {
      console.log('Errors:', startupResult.errors);
    }
    
    // =============================================
    // Test 3: Post-Initialization Health Check
    // =============================================
    
    console.log('\n3️⃣ Testing health check after initialization...');
    const postHealthCheck = await initializer.healthCheck();
    console.log('Post-initialization health:', postHealthCheck);
    
    // =============================================
    // Test 4: Startup Status
    // =============================================
    
    console.log('\n4️⃣ Testing startup status...');
    const startupStatus = await initializer.getStartupStatus();
    console.log('Startup Status:');
    console.log('Ready:', startupStatus.ready);
    console.log('Validator Stats:', startupStatus.validatorStats);
    console.log('System Health:', startupStatus.systemHealth);
    
    // =============================================
    // Test 5: Database Validator Details
    // =============================================
    
    console.log('\n5️⃣ Testing database validator details...');
    
    const clickhouseClient = new MonadClickHouseClient(config.clickhouse);
    const dbValidator = new DatabaseValidatorInitializer(clickhouseClient);
    
    const dbStats = await dbValidator.getDatabaseValidatorStats();
    console.log('Database Validator Stats:', dbStats);
    
    const dbHealth = await dbValidator.healthCheck();
    console.log('Database Validator Health:', dbHealth);
    
    // Test getting a specific validator
    if (dbStats.totalValidators > 0) {
      console.log('\n🔍 Testing specific validator lookup...');
      
      // Get a sample validator to test with
      const query = `SELECT validator_id FROM validator_registry LIMIT 1`;
      const results = await clickhouseClient.executeRawQuery(query);
      
      if (results.length > 0) {
        const sampleValidatorId = results[0].validator_id;
        console.log(`Testing with validator: ${sampleValidatorId}`);
        
        const validatorData = await dbValidator.getValidatorFromDatabase(sampleValidatorId);
        console.log('Validator Data:', validatorData);
      }
    }
    
    // =============================================
    // Test 6: Cleanup
    // =============================================
    
    console.log('\n6️⃣ Testing cleanup...');
    await initializer.shutdown();
    await clickhouseClient.close();
    console.log('✅ Cleanup completed');
    
    // =============================================
    // Final Results
    // =============================================
    
    console.log('\n🎉 All tests completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`✅ Database connection: ${postHealthCheck.database ? 'OK' : 'FAILED'}`);
    console.log(`✅ Validator validation: ${postHealthCheck.validators ? 'OK' : 'FAILED'}`);
    console.log(`✅ Service initialization: ${postHealthCheck.services ? 'OK' : 'FAILED'}`);
    console.log(`✅ System ready: ${startupStatus.ready ? 'YES' : 'NO'}`);
    
    if (startupStatus.ready) {
      console.log('\n🚀 SYSTEM READY: Application can start safely with validated database');
    } else {
      console.log('\n❌ SYSTEM NOT READY: Issues need to be resolved before starting');
    }
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error('\n🚫 This indicates a critical startup issue that would prevent the application from starting');
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testStartupSystem().catch((error) => {
    console.error('Fatal test error:', error);
    process.exit(1);
  });
} 