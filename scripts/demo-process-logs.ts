#!/usr/bin/env ts-node

// Demo script to test log processing with provided sample files
import { readFileSync } from 'fs';
import { join } from 'path';
import { LogProcessor } from '../src/log-processor/processor';

async function processLogFiles() {
  console.log('🔄 Demo: Processing Monad log files...');

  const processor = new LogProcessor();
  let totalProcessed = 0;
  let totalEvents = 0;

  try {
    // Process monad-bft.log
    console.log('\n📋 Processing monad-bft.log...');
    const bftLogPath = join(__dirname, '../examples/monad-bft.log');
    const bftContent = readFileSync(bftLogPath, 'utf-8');
    const bftLines = bftContent.split('\n').filter(line => line.trim());
    
    console.log(`  📊 Found ${bftLines.length} log lines`);
    
    const bftEvents = [];
    for (const line of bftLines) {
      try {
        const event = processor.parseLog(line);
        if (event) {
          bftEvents.push(event);
        }
        totalProcessed++;
      } catch (error) {
        console.log(`  ⚠️ Failed to parse line: ${error}`);
      }
    }
    
    console.log(`  ✅ Parsed ${bftEvents.length} consensus events`);
    totalEvents += bftEvents.length;

    // Show sample of parsed events
    if (bftEvents.length > 0) {
      console.log('\n  📋 Sample consensus events:');
      bftEvents.slice(0, 3).forEach((event, i) => {
        console.log(`    ${i + 1}. ${event.eventType} | Validator: ${event.validatorId.substring(0, 12)}... | Round: ${event.roundNumber}`);
      });
    }

    // Process ledger-tail.log
    console.log('\n📋 Processing ledger-tail.log...');
    const ledgerLogPath = join(__dirname, '../examples/ledger-tail.log');
    const ledgerContent = readFileSync(ledgerLogPath, 'utf-8');
    const ledgerLines = ledgerContent.split('\n').filter(line => line.trim());
    
    console.log(`  📊 Found ${ledgerLines.length} log lines`);
    
    const ledgerEvents = [];
    for (const line of ledgerLines) {
      try {
        const event = processor.parseLog(line);
        if (event) {
          ledgerEvents.push(event);
        }
        totalProcessed++;
      } catch (error) {
        console.log(`  ⚠️ Failed to parse line: ${error}`);
      }
    }
    
    console.log(`  ✅ Parsed ${ledgerEvents.length} ledger events`);
    totalEvents += ledgerEvents.length;

    // Show sample of parsed events
    if (ledgerEvents.length > 0) {
      console.log('\n  📋 Sample ledger events:');
      ledgerEvents.slice(0, 3).forEach((event, i) => {
        console.log(`    ${i + 1}. ${event.eventType} | Validator: ${event.validatorId.substring(0, 12)}... | Round: ${event.roundNumber}`);
      });
    }

    // Summary
    console.log('\n📊 Processing Summary:');
    console.log(`  📝 Total log lines processed: ${totalProcessed}`);
    console.log(`  ✅ Total events generated: ${totalEvents}`);
    console.log(`  📈 Success rate: ${((totalEvents / totalProcessed) * 100).toFixed(1)}%`);

    // Analyze event types
    const allEvents = [...bftEvents, ...ledgerEvents];
    const eventTypeCounts: Record<string, number> = {};
    
    allEvents.forEach(event => {
      eventTypeCounts[event.eventType] = (eventTypeCounts[event.eventType] || 0) + 1;
    });

    console.log('\n📋 Event Type Distribution:');
    Object.entries(eventTypeCounts)
      .sort(([,a], [,b]) => (b as number) - (a as number))
      .forEach(([type, count]) => {
        console.log(`  📊 ${type}: ${count} events`);
      });

    // Check for unique validators
    const uniqueValidators = new Set(allEvents.map(e => e.validatorId));
    console.log(`\n👥 Unique validators found: ${uniqueValidators.size}`);
    
    if (uniqueValidators.size > 0) {
      console.log('  📋 Validator IDs (first 3):');
      Array.from(uniqueValidators).slice(0, 3).forEach((id, i) => {
        console.log(`    ${i + 1}. ${id.substring(0, 12)}...${id.substring(id.length - 4)}`);
      });
    }

    console.log('\n🎉 Demo log processing completed successfully!');
    console.log('💡 Next step: Run with infrastructure to store in database');

  } catch (error) {
    console.error('❌ Demo processing failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  processLogFiles().catch(console.error);
} 