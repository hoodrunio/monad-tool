#!/usr/bin/env ts-node

import { MonadClickHouseClient, ClickHouseConfig } from '../src/database/clickhouse-client';
import { DomainExtractor } from '../src/services/dns/DomainExtractor';

interface ValidatorRecord {
  validator_id: string;
  dns_address: string;
  dns_host: string;
  provider: string;
  location: string;
}

interface ExtractionResult {
  validatorName: string;
  method: 'custom_mapping' | 'default_extraction' | 'provider_fallback' | 'unknown';
  source: string;
}

class ValidatorNamesFixer {
  private clickhouseClient: MonadClickHouseClient;
  private domainExtractor: DomainExtractor;

  constructor() {
    const config: ClickHouseConfig = {
      host: process.env.CLICKHOUSE_HOST || 'localhost',
      port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
      max_open_connections: 10,
      max_query_timeout: 30000,
      compression: true
    };
    
    this.clickhouseClient = new MonadClickHouseClient(config);
    this.domainExtractor = new DomainExtractor();
  }

  async run(): Promise<void> {
    try {
      console.log('🔧 Starting Validator Names Schema Fix...\n');

      // Step 0: Show current custom mappings
      await this.showCustomMappings();

      // Step 1: Check current table structure
      await this.checkTableStructure();

      // Step 2: Add missing columns if they don't exist
      await this.ensureColumnsExist();

      // Step 3: Get current validator data
      const validators = await this.getCurrentValidators();
      console.log(`📊 Found ${validators.length} validators in registry`);

      // Step 4: Extract and populate validator names
      await this.populateValidatorNames(validators);

      // Step 5: Verify the results
      await this.verifyResults();

      console.log('\n✅ Validator names schema fix completed successfully!');

    } catch (error) {
      console.error('❌ Failed to fix validator names schema:', error);
      throw error;
    } finally {
      await this.clickhouseClient.close();
    }
  }

  private async showCustomMappings(): Promise<void> {
    console.log('🗺️  Current Custom Domain Mappings:');
    const mappings = DomainExtractor.getCustomMappings();
    
    if (mappings.size === 0) {
      console.log('   No custom mappings configured');
    } else {
      mappings.forEach((validatorName, hostname) => {
        console.log(`   ${hostname} → ${validatorName}`);
      });
    }
    console.log(`   Total: ${mappings.size} custom mappings\n`);
  }

  private async checkTableStructure(): Promise<void> {
    console.log('🔍 Checking validator_registry table structure...');
    
    const query = `
      SELECT name, type, default_expression 
      FROM system.columns 
      WHERE table = 'validator_registry' 
        AND database = 'monad_analytics'
      ORDER BY name
    `;

    const columns = await this.clickhouseClient.executeRawQuery(query);
    console.log('Current columns:', columns.map(c => `${c.name} (${c.type})`).join(', '));
    
    // Check if validator_name exists
    const hasValidatorName = columns.some(c => c.name === 'validator_name');
    const hasCountry = columns.some(c => c.name === 'country');
    const hasDatacenter = columns.some(c => c.name === 'datacenter');
    
    console.log(`validator_name column exists: ${hasValidatorName}`);
    console.log(`country column exists: ${hasCountry}`);
    console.log(`datacenter column exists: ${hasDatacenter}`);
  }

  private async ensureColumnsExist(): Promise<void> {
    console.log('\n🔨 Adding missing columns...');

    const columnsToAdd = [
      {
        name: 'validator_name',
        definition: "LowCardinality(String) DEFAULT 'unknown'",
        description: 'Validator name extracted from DNS'
      },
      {
        name: 'country',
        definition: "LowCardinality(String) DEFAULT 'unknown'",
        description: 'Country from geolocation'
      },
      {
        name: 'datacenter',
        definition: "LowCardinality(String) DEFAULT 'unknown'",
        description: 'Datacenter/ISP information'
      }
    ];

    for (const column of columnsToAdd) {
      try {
        const alterQuery = `
          ALTER TABLE validator_registry 
          ADD COLUMN IF NOT EXISTS ${column.name} ${column.definition}
        `;
        
        await this.clickhouseClient.executeRawQuery(alterQuery);
        console.log(`✅ Added/ensured column: ${column.name} - ${column.description}`);
      } catch (error) {
        console.log(`⚠️  Column ${column.name} might already exist:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async getCurrentValidators(): Promise<ValidatorRecord[]> {
    console.log('\n📋 Getting current validator data...');
    
    const query = `
      SELECT 
        validator_id,
        dns_address,
        dns_host,
        provider,
        location
      FROM validator_registry 
      WHERE is_active = 1
      ORDER BY validator_id
    `;

    const validators = await this.clickhouseClient.executeRawQuery(query);
    return validators as ValidatorRecord[];
  }

  private async populateValidatorNames(validators: ValidatorRecord[]): Promise<void> {
    console.log('\n🏷️  Extracting and updating validator names...');

    let updatedCount = 0;
    let customMappingCount = 0;
    let defaultExtractionCount = 0;
    let providerFallbackCount = 0;
    const batchSize = 50;

    for (let i = 0; i < validators.length; i += batchSize) {
      const batch = validators.slice(i, i + batchSize);
      
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(validators.length/batchSize)} (${batch.length} validators)...`);

      for (const validator of batch) {
        try {
          const extractionResult = this.extractValidatorNameWithMethod(validator);
          
          if (extractionResult.validatorName && extractionResult.validatorName !== 'unknown') {
            await this.updateValidatorName(validator.validator_id, extractionResult.validatorName);
            updatedCount++;
            
            // Count extraction methods
            switch (extractionResult.method) {
              case 'custom_mapping':
                customMappingCount++;
                console.log(`  🎯 ${validator.validator_id}: "${extractionResult.validatorName}" (custom mapping from ${extractionResult.source})`);
                break;
              case 'default_extraction':
                defaultExtractionCount++;
                console.log(`  ✅ ${validator.validator_id}: "${extractionResult.validatorName}" (extracted from ${extractionResult.source})`);
                break;
              case 'provider_fallback':
                providerFallbackCount++;
                console.log(`  📍 ${validator.validator_id}: "${extractionResult.validatorName}" (provider fallback)`);
                break;
            }
          } else {
            console.log(`  ⚠️  ${validator.validator_id}: No name extracted (DNS: ${validator.dns_address || 'none'})`);
          }
        } catch (error) {
          console.log(`  ❌ ${validator.validator_id}: Error - ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Small delay between batches
      if (i + batchSize < validators.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`\n📊 Extraction Summary:`);
    console.log(`   Total Updated: ${updatedCount}/${validators.length}`);
    console.log(`   Custom Mappings: ${customMappingCount}`);
    console.log(`   Default Extraction: ${defaultExtractionCount}`);
    console.log(`   Provider Fallback: ${providerFallbackCount}`);
  }

  private extractValidatorNameWithMethod(validator: ValidatorRecord): ExtractionResult {
    // Strategy 1: Check DNS host with custom mappings first
    if (validator.dns_host) {
      const hasCustomMapping = DomainExtractor.hasCustomMapping(validator.dns_host);
      const name = this.domainExtractor.extractValidatorName(validator.dns_host);
      
      if (name && name !== 'unknown') {
        return {
          validatorName: name,
          method: hasCustomMapping ? 'custom_mapping' : 'default_extraction',
          source: validator.dns_host
        };
      }
    }

    // Strategy 2: Check DNS address with custom mappings
    if (validator.dns_address) {
      const hasCustomMapping = DomainExtractor.hasCustomMapping(validator.dns_address);
      const name = this.domainExtractor.extractValidatorName(validator.dns_address);
      
      if (name && name !== 'unknown') {
        return {
          validatorName: name,
          method: hasCustomMapping ? 'custom_mapping' : 'default_extraction',
          source: validator.dns_address
        };
      }
    }

    // Strategy 3: Use provider as fallback
    if (validator.provider && validator.provider !== 'unknown') {
      return {
        validatorName: `${validator.provider}_validator`,
        method: 'provider_fallback',
        source: 'provider'
      };
    }

    return {
      validatorName: 'unknown',
      method: 'unknown',
      source: 'none'
    };
  }

  private async updateValidatorName(validatorId: string, validatorName: string): Promise<void> {
    // First, get the current record data
    const selectQuery = `
      SELECT 
        validator_id,
        node_id,
        epoch,
        stake,
        position,
        is_active,
        dns_address,
        dns_host,
        dns_port,
        provider,
        location,
        country,
        datacenter,
        first_seen
      FROM validator_registry 
      WHERE validator_id = '${validatorId}' 
      ORDER BY last_updated DESC 
      LIMIT 1
    `;

    const existingRecords = await this.clickhouseClient.executeRawQuery(selectQuery);
    
    if (existingRecords.length === 0) {
      console.log(`  ⚠️  No existing record found for ${validatorId}`);
      return;
    }

    const existing = existingRecords[0];

    // Format timestamp properly for ClickHouse
    const formatTimestamp = (dateStr: string): string => {
      if (!dateStr) return new Date().toISOString().replace('T', ' ').replace('Z', '');
      return new Date(dateStr).toISOString().replace('T', ' ').replace('Z', '');
    };

    // Prepare the record for insertion using the client's insert method
    const newRecord = {
      validator_id: existing.validator_id,
      node_id: existing.node_id,
      epoch: existing.epoch,
      stake: existing.stake,
      position: existing.position,
      is_active: existing.is_active,
      dns_address: existing.dns_address || '',
      dns_host: existing.dns_host || '',
      dns_port: existing.dns_port || 8000,
      validator_name: validatorName,
      provider: existing.provider || 'unknown',
      location: existing.location || 'unknown',
      country: existing.country || 'unknown',
      datacenter: existing.datacenter || 'unknown',
      first_seen: formatTimestamp(existing.first_seen),
      last_updated: formatTimestamp(new Date().toISOString())
    };

    // Use the ClickHouse client's built-in insert method (properly accessing the client)
    await this.clickhouseClient['client'].insert({
      table: 'validator_registry',
      values: [newRecord],
      format: 'JSONEachRow'
    });
  }

  private async verifyResults(): Promise<void> {
    console.log('\n📈 Verifying results...');

    // First, optimize the table to ensure ReplacingMergeTree deduplication takes effect
    console.log('🔄 Optimizing validator_registry table for deduplication...');
    try {
      await this.clickhouseClient.executeRawQuery('OPTIMIZE TABLE validator_registry FINAL');
      console.log('✅ Table optimization completed');
    } catch (error) {
      console.log('⚠️  Table optimization failed (this is often expected):', error instanceof Error ? error.message : String(error));
    }

    // Small delay to let optimization complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    const statsQuery = `
      SELECT 
        COUNT(*) as total_validators,
        COUNT(CASE WHEN validator_name != 'unknown' THEN 1 END) as validators_with_names,
        COUNT(CASE WHEN validator_name = 'unknown' THEN 1 END) as validators_without_names,
        (COUNT(CASE WHEN validator_name != 'unknown' THEN 1 END) * 100.0 / COUNT(*)) as name_completion_rate
      FROM validator_registry 
      WHERE is_active = 1
    `;

    const stats = await this.clickhouseClient.executeRawQuery(statsQuery);
    const [result] = stats;

    console.log('\n📊 Validator Names Status:');
    console.log(`Total Validators: ${result.total_validators}`);
    console.log(`With Names: ${result.validators_with_names}`);
    console.log(`Without Names: ${result.validators_without_names}`);
    console.log(`Completion Rate: ${parseFloat(result.name_completion_rate).toFixed(1)}%`);

    // Show some examples with method breakdown
    const examplesQuery = `
      SELECT validator_id, validator_name, dns_address, dns_host, provider
      FROM validator_registry 
      WHERE is_active = 1 AND validator_name != 'unknown'
      ORDER BY validator_name
      LIMIT 15
    `;

    const examples = await this.clickhouseClient.executeRawQuery(examplesQuery);
    
    if (examples.length > 0) {
      console.log('\n🏷️  Sample Validator Names:');
      examples.forEach(v => {
        const source = v.dns_host || v.dns_address || 'provider';
        const hasCustomMapping = DomainExtractor.hasCustomMapping(source);
        const method = hasCustomMapping ? '🎯' : (source === 'provider' ? '📍' : '✅');
        
        console.log(`  ${method} ${v.validator_name} (${v.validator_id.slice(0, 8)}...) - ${source}`);
      });
      
      console.log('\n🏷️  Legend:');
      console.log('   🎯 = Custom mapping');
      console.log('   ✅ = Default extraction');
      console.log('   📍 = Provider fallback');
    }
  }
}

// Main execution
if (require.main === module) {
  const fixer = new ValidatorNamesFixer();
  fixer.run().catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}

export { ValidatorNamesFixer }; 