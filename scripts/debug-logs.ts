import 'dotenv/config';
import { FocusedLogProcessor } from '../src/log-processor/enhanced-processor';
import { EventTypeMapping } from '../src/log-processor/types';
import fs from 'fs';
import readline from 'readline';

async function debugLogProcessing() {
  console.log('🔍 Debug: Analyzing log processing...');
  
  // Initialize the enhanced processor
  const config = {
    batchSize: 100,
    batchTimeoutMs: 5000,
    maxRetries: 3,
    enableQCParsing: true,
    enableVoteChainAnalysis: true,
    enableGeographicIntelligence: true,
    parallelProcessing: true,
    maxConcurrentBatches: 5
  };
  
  const processor = new FocusedLogProcessor();
  
  // Check what event types we're looking for
  console.log('📋 Available event type mappings:');
  Object.entries(EventTypeMapping).forEach(([message, eventType]) => {
    console.log(`  "${message}" -> ${eventType}`);
  });
  
  // Try to get some sample logs from journalctl directly
  console.log('\n🔄 Fetching sample logs from journalctl...');
  
  try {
    const { spawn } = require('child_process');
    
    // Get a few logs from monad-bft
    const bftProcess = spawn('journalctl', [
      '-u', 'monad-bft',
      '-o', 'json',
      '--lines', '5',
      '--no-pager'
    ]);
    
    let bftLogs = '';
    bftProcess.stdout.on('data', (data: Buffer) => {
      bftLogs += data.toString();
    });
    
    await new Promise((resolve) => {
      bftProcess.on('close', resolve);
    });
    
    console.log('📄 Sample monad-bft logs:');
    const bftLogLines = bftLogs.trim().split('\n').filter(line => line.trim());
    bftLogLines.forEach((line, i) => {
      try {
        const log = JSON.parse(line);
        console.log(`\n  Log ${i + 1}:`);
        console.log(`    MESSAGE: "${log.MESSAGE || 'N/A'}"`);
        console.log(`    SYSLOG_IDENTIFIER: "${log.SYSLOG_IDENTIFIER || 'N/A'}"`);
        console.log(`    _SYSTEMD_UNIT: "${log._SYSTEMD_UNIT || 'N/A'}"`);
        
        // Try to find fields that might contain JSON
        Object.keys(log).forEach(key => {
          if (typeof log[key] === 'string' && log[key].includes('{')) {
            console.log(`    ${key} (contains JSON): ${log[key].substring(0, 100)}...`);
          }
        });
      } catch (e) {
        console.log(`    Raw line ${i + 1}: ${line.substring(0, 100)}...`);
      }
    });
    
    // Get a few logs from monad-ledger-tail
    const ledgerProcess = spawn('journalctl', [
      '-u', 'monad-ledger-tail',
      '-o', 'json',
      '--lines', '5',
      '--no-pager'
    ]);
    
    let ledgerLogs = '';
    ledgerProcess.stdout.on('data', (data: Buffer) => {
      ledgerLogs += data.toString();
    });
    
    await new Promise((resolve) => {
      ledgerProcess.on('close', resolve);
    });
    
    console.log('\n📄 Sample monad-ledger-tail logs:');
    const ledgerLogLines = ledgerLogs.trim().split('\n').filter(line => line.trim());
    ledgerLogLines.forEach((line, i) => {
      try {
        const log = JSON.parse(line);
        console.log(`\n  Log ${i + 1}:`);
        console.log(`    MESSAGE: "${log.MESSAGE || 'N/A'}"`);
        console.log(`    SYSLOG_IDENTIFIER: "${log.SYSLOG_IDENTIFIER || 'N/A'}"`);
        console.log(`    _SYSTEMD_UNIT: "${log._SYSTEMD_UNIT || 'N/A'}"`);
        
        // Try to find fields that might contain JSON
        Object.keys(log).forEach(key => {
          if (typeof log[key] === 'string' && log[key].includes('{')) {
            console.log(`    ${key} (contains JSON): ${log[key].substring(0, 100)}...`);
          }
        });
      } catch (e) {
        console.log(`    Raw line ${i + 1}: ${line.substring(0, 100)}...`);
      }
    });
    
    // Now try to process some of these logs
    console.log('\n🧪 Testing log processing...');
    
    // Create sample RawLog objects from the journalctl data
    const testLogs: any[] = [];
    
    // Process monad-bft logs (consensus)
    for (const line of bftLogLines.slice(0, 2)) {
      try {
        const log = JSON.parse(line);
        
        // Check if MESSAGE contains JSON
        if (log.MESSAGE && log.MESSAGE.includes('{')) {
          try {
            const logContent = JSON.parse(log.MESSAGE);
            testLogs.push({
              timestamp: logContent.timestamp || new Date().toISOString(),
              level: logContent.level || 'INFO',
              fields: logContent.fields || {},
              target: 'monad_consensus_state'
            });
          } catch (e) {
            // Not JSON in MESSAGE
          }
        }
      } catch (e: any) {
        console.log(`    Error processing BFT line: ${e.message}`);
      }
    }
    
    // Process monad-ledger-tail logs (ledger)
    for (const line of ledgerLogLines.slice(0, 3)) {
      try {
        const log = JSON.parse(line);
        
        // Check if MESSAGE contains JSON
        if (log.MESSAGE && log.MESSAGE.includes('{')) {
          try {
            const logContent = JSON.parse(log.MESSAGE);
            testLogs.push({
              timestamp: logContent.timestamp || new Date().toISOString(),
              level: logContent.level || 'INFO',
              fields: logContent.fields || {},
              target: 'ledger_tail'
            });
          } catch (e) {
            // Not JSON in MESSAGE
          }
        }
      } catch (e: any) {
        console.log(`    Error processing ledger line: ${e.message}`);
      }
    }
    
    if (testLogs.length > 0) {
      console.log(`\n🔬 Processing ${testLogs.length} test logs...`);
      
      const result = await processor.processLogBatch(testLogs);
      
      console.log(`\n📊 Processing results:`);
      console.log(`  Events generated: ${result.consensusEvents.length + result.ledgerEvents.length}`);
      console.log(`  QC participation data: ${result.qcParticipationData.length}`);
      console.log(`  Validator infrastructure: ${result.validatorInfrastructure.length}`);
      console.log(`  Errors: ${result.errors.length}`);
      
      if (result.errors.length > 0) {
        console.log(`\n❌ Processing errors:`);
        result.errors.forEach((error, i) => {
          console.log(`  ${i + 1}. ${error}`);
          console.log(`     Log content: ${error.substring(0, 100)}...`);
        });
      }
      
      if (result.consensusEvents.length + result.ledgerEvents.length > 0) {
        console.log(`\n✅ Generated events:`);
        [...result.consensusEvents, ...result.ledgerEvents].forEach((event, i) => {
          console.log(`  ${i + 1}. ${event.eventType} - Validator: ${event.validatorId} - Round: ${event.roundNumber}`);
        });
      } else {
        console.log(`\n⚠️  No events generated. Checking why...`);
        
        // Debug the first test log
        if (testLogs[0]) {
          const testLog = testLogs[0];
          console.log(`\n🔍 Debugging first test log:`);
          console.log(`  Timestamp: ${testLog.timestamp}`);
          console.log(`  Level: ${testLog.level}`);
          console.log(`  Target: ${testLog.target}`);
          console.log(`  Fields:`, JSON.stringify(testLog.fields, null, 2));
          
          // Check if the message field matches any event type
          const message = testLog.fields?.message;
          if (message) {
            console.log(`\n  Message: "${message}"`);
            console.log(`  Event type mapping: ${EventTypeMapping[message] || 'NOT FOUND'}`);
            
            // Check for similar messages
            const similarMessages = Object.keys(EventTypeMapping).filter(key => 
              key.toLowerCase().includes(message.toLowerCase()) || 
              message.toLowerCase().includes(key.toLowerCase())
            );
            
            if (similarMessages.length > 0) {
              console.log(`  Similar messages found:`, similarMessages);
            }
          } else {
            console.log(`\n  ❌ No 'message' field found in fields object`);
          }
        }
      }
    } else {
      console.log('\n❌ No valid test logs could be created');
    }
    
  } catch (error) {
    console.error('❌ Error debugging logs:', error);
  }
}

debugLogProcessing().catch(console.error); 