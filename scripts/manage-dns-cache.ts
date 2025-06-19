#!/usr/bin/env tsx

import { ValidatorInfoService } from '../src/services/validator-info-service';
import { MonadClickHouseClient } from '../src/database/clickhouse-client';

async function manageDnsCache() {
  const command = process.argv[2];
  
  if (!command) {
    console.log('🛠️  DNS Cache Management Tool');
    console.log('Usage: tsx scripts/manage-dns-cache.ts <command>');
    console.log('');
    console.log('Commands:');
    console.log('  status    - Show current cache status');
    console.log('  clear     - Clear all cache from database');
    console.log('  refresh   - Force refresh cache from database');
    console.log('  rebuild   - Clear cache and rebuild from DNS');
    console.log('');
    return;
  }

  try {
    const validatorInfoService = new ValidatorInfoService();
    await validatorInfoService.initialize();
    
    switch (command) {
      case 'status':
        await showCacheStatus(validatorInfoService);
        break;
        
      case 'clear':
        await clearCache(validatorInfoService);
        break;
        
      case 'refresh':
        await refreshCache(validatorInfoService);
        break;
        
      case 'rebuild':
        await rebuildCache(validatorInfoService);
        break;
        
      default:
        console.log(`❌ Unknown command: ${command}`);
        console.log('Use: status, clear, refresh, or rebuild');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

async function showCacheStatus(service: ValidatorInfoService) {
  console.log('📊 DNS Cache Status');
  console.log('=' .repeat(40));
  
  const status = service.getCacheStatus();
  const stats = service.getStats();
  
  console.log(`📈 Total Validators: ${stats.totalValidators}`);
  console.log(`💾 Cached Entries: ${status.totalCached}`);
  console.log(`✅ Valid Entries: ${status.validEntries}`);
  console.log(`❌ Expired Entries: ${status.expiredEntries}`);
  console.log(`🌐 Entries with DNS: ${status.entriesWithDns}`);
  console.log(`📅 Average Age: ${status.avgAge} hours`);
  console.log(`🎯 DNS Coverage: ${stats.dnsCoverage.toFixed(1)}%`);
  
  if (status.oldestEntry) {
    console.log(`⏰ Oldest Entry: ${status.oldestEntry.toISOString()}`);
  }
  if (status.newestEntry) {
    console.log(`🆕 Newest Entry: ${status.newestEntry.toISOString()}`);
  }
  
  // Cache effectiveness
  const effectiveness = (status.validEntries / stats.totalValidators) * 100;
  if (effectiveness > 90) {
    console.log('🟢 Cache Status: EXCELLENT (>90% coverage)');
  } else if (effectiveness > 70) {
    console.log('🟡 Cache Status: GOOD (>70% coverage)');
  } else {
    console.log('🔴 Cache Status: POOR (<70% coverage)');
  }
}

async function clearCache(service: ValidatorInfoService) {
  console.log('🗑️  Clearing DNS cache from database...');
  
  // We need to access the ClickHouse client to clear the cache table
  const clickhouse = (service as any).clickhouse as MonadClickHouseClient;
  
  try {
    await clickhouse.executeCommand('TRUNCATE TABLE validator_info_cache');
    console.log('✅ Database cache cleared successfully');
    
    // Also clear in-memory cache
    service.cleanupCache();
    console.log('✅ In-memory cache cleared successfully');
    
  } catch (error) {
    console.error('❌ Failed to clear cache:', error);
  }
}

async function refreshCache(service: ValidatorInfoService) {
  console.log('🔄 Refreshing cache from database...');
  
  const beforeStatus = service.getCacheStatus();
  console.log(`📊 Before: ${beforeStatus.totalCached} entries`);
  
  await service.forceReloadFromDatabase();
  
  const afterStatus = service.getCacheStatus();
  console.log(`📊 After: ${afterStatus.totalCached} entries (${afterStatus.validEntries} valid)`);
  
  console.log('✅ Cache refresh completed');
}

async function rebuildCache(service: ValidatorInfoService) {
  console.log('🔨 Rebuilding cache from scratch...');
  console.log('⚠️  This will take several minutes as it processes DNS for all validators');
  
  // Clear existing cache
  await clearCache(service);
  
  // Rebuild cache
  console.log('🔄 Starting DNS processing...');
  const startTime = Date.now();
  
  await service.preProcessAll();
  
  const processingTime = Date.now() - startTime;
  console.log(`⏱️  Processing completed in ${Math.round(processingTime / 1000)}s`);
  
  // Show final status
  await showCacheStatus(service);
  
  console.log('✅ Cache rebuild completed');
}

// Run the tool
manageDnsCache().catch(console.error); 