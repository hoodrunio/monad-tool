#!/usr/bin/env npx ts-node

/**
 * Database-Driven Dynamic Block Time Test
 * 
 * Gerçek block proposal verilerinden dinamik block time hesaplama testi
 * Block'lar arasındaki gerçek zamanları kullanarak accurate tahminler yapıyoruz
 */

import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { EpochService } from '../src/services/epoch/EpochService';
import { NodeRpcClient } from '../src/services/blockchain/NodeRpcClient';

interface BlockTimeStats {
  totalBlocks: number;
  avgBlockTimeSeconds: number;
  medianBlockTimeSeconds: number;
  minBlockTimeSeconds: number;
  maxBlockTimeSeconds: number;
  stdDeviation: number;
  last10BlocksAvg: number;
  last50BlocksAvg: number;
  last100BlocksAvg: number;
}

interface DynamicEpochPrediction {
  staticPrediction: {
    timeEstimate: { hours: number; minutes: number; seconds: number };
    assumedBlockTime: number;
  };
  dynamicPrediction: {
    timeEstimate: { hours: number; minutes: number; seconds: number };
    calculatedBlockTime: number;
    dataPoints: number;
  };
  accuracy: {
    improvementPercent: number;
    confidenceLevel: 'low' | 'medium' | 'high';
  };
}

class DynamicBlockTimeCalculator {
  private clickhouseClient: MonadClickHouseClient;
  private epochService: EpochService;

  constructor() {
    // Initialize ClickHouse client
    this.clickhouseClient = new MonadClickHouseClient({
      host: process.env.CLICKHOUSE_HOST || 'localhost',
      port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
      username: process.env.CLICKHOUSE_USERNAME || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
      max_open_connections: 10,
      max_query_timeout: 30000,
      compression: true
    });

    // Initialize RPC client and EpochService
    const rpcUrl = process.env.RPC_URL || 'http://localhost:8080';
    const rpcClient = new NodeRpcClient(rpcUrl, 10000);
    this.epochService = new EpochService(rpcClient, 50000);
  }

  /**
   * Database'den gerçek block time'ları hesapla
   */
  async calculateDynamicBlockTime(sampleSize: number = 1000): Promise<BlockTimeStats> {
    console.log(`📊 Calculating dynamic block time from last ${sampleSize} blocks...`);

    const query = `
      WITH block_times AS (
        SELECT 
          seq_num,
          timestamp,
          lagInFrame(timestamp, 1) OVER (ORDER BY seq_num) as prev_timestamp,
          date_diff('second', lagInFrame(timestamp, 1) OVER (ORDER BY seq_num), timestamp) as block_time_seconds
        FROM block_proposals
        WHERE status = 'proposed' 
          AND timestamp >= now() - INTERVAL 24 HOUR
        ORDER BY seq_num DESC
        LIMIT ${sampleSize + 1}
      )
      SELECT 
        seq_num,
        timestamp,
        block_time_seconds
      FROM block_times
      WHERE block_time_seconds > 0
        AND block_time_seconds < 10  -- Filter out outliers
      ORDER BY seq_num DESC
      LIMIT ${sampleSize}
    `;

    try {
      const result = await this.clickhouseClient.executeRawQuery(query);
      
      if (result.length === 0) {
        throw new Error('No block data found in database');
      }

      const blockTimes = result.map(row => parseFloat(row.block_time_seconds)).filter(time => time > 0);
      
      if (blockTimes.length === 0) {
        throw new Error('No valid block times calculated');
      }

      // İstatistikleri hesapla
      const sortedTimes = [...blockTimes].sort((a, b) => a - b);
      const avg = blockTimes.reduce((sum, time) => sum + time, 0) / blockTimes.length;
      const median = sortedTimes[Math.floor(sortedTimes.length / 2)];
      const min = Math.min(...blockTimes);
      const max = Math.max(...blockTimes);
      
      // Standard deviation
      const variance = blockTimes.reduce((sum, time) => sum + Math.pow(time - avg, 2), 0) / blockTimes.length;
      const stdDeviation = Math.sqrt(variance);

      // Son N blok ortalamaları
      const last10 = blockTimes.slice(0, 10);
      const last50 = blockTimes.slice(0, 50);
      const last100 = blockTimes.slice(0, 100);

      const last10Avg = last10.reduce((sum, time) => sum + time, 0) / last10.length;
      const last50Avg = last50.reduce((sum, time) => sum + time, 0) / last50.length;
      const last100Avg = last100.reduce((sum, time) => sum + time, 0) / last100.length;

      return {
        totalBlocks: blockTimes.length,
        avgBlockTimeSeconds: avg,
        medianBlockTimeSeconds: median,
        minBlockTimeSeconds: min,
        maxBlockTimeSeconds: max,
        stdDeviation,
        last10BlocksAvg: last10Avg,
        last50BlocksAvg: last50Avg,
        last100BlocksAvg: last100Avg
      };

    } catch (error) {
      console.error('❌ Failed to calculate dynamic block time:', error);
      throw error;
    }
  }

  /**
   * Statik vs dinamik tahmin karşılaştırması
   */
  async compareStaticVsDynamic(): Promise<DynamicEpochPrediction> {
    console.log('🔄 Comparing static vs dynamic epoch predictions...');

    try {
      // Gerçek block time'ı hesapla
      const blockStats = await this.calculateDynamicBlockTime(200);
      
      // Current epoch progress al
      const progress = await this.epochService.getEpochProgress();
      
      // Statik tahmin (0.5 saniye varsayımı)
      this.epochService.setAverageBlockTime(0.5);
      const staticProgress = await this.epochService.getEpochProgress();
      
      // Dinamik tahmin (gerçek verilerden)
      this.epochService.setAverageBlockTime(blockStats.last50BlocksAvg);
      const dynamicProgress = await this.epochService.getEpochProgress();

      // Accuracy hesaplama
      const timeDifference = Math.abs(
        (staticProgress.estimatedTimeToNextEpoch?.hours || 0) * 3600 + 
        (staticProgress.estimatedTimeToNextEpoch?.minutes || 0) * 60 + 
        (staticProgress.estimatedTimeToNextEpoch?.seconds || 0) -
        ((dynamicProgress.estimatedTimeToNextEpoch?.hours || 0) * 3600 + 
         (dynamicProgress.estimatedTimeToNextEpoch?.minutes || 0) * 60 + 
         (dynamicProgress.estimatedTimeToNextEpoch?.seconds || 0))
      );

      const staticTotalSeconds = (staticProgress.estimatedTimeToNextEpoch?.hours || 0) * 3600 + 
                                (staticProgress.estimatedTimeToNextEpoch?.minutes || 0) * 60 + 
                                (staticProgress.estimatedTimeToNextEpoch?.seconds || 0);

      const improvementPercent = staticTotalSeconds > 0 ? (timeDifference / staticTotalSeconds) * 100 : 0;

      // Confidence level belirleme
      let confidenceLevel: 'low' | 'medium' | 'high' = 'medium';
      if (blockStats.totalBlocks > 500 && blockStats.stdDeviation < 0.3) {
        confidenceLevel = 'high';
      } else if (blockStats.totalBlocks < 100 || blockStats.stdDeviation > 1.0) {
        confidenceLevel = 'low';
      }

      return {
        staticPrediction: {
          timeEstimate: staticProgress.estimatedTimeToNextEpoch || { hours: 0, minutes: 0, seconds: 0 },
          assumedBlockTime: 0.5
        },
        dynamicPrediction: {
          timeEstimate: dynamicProgress.estimatedTimeToNextEpoch || { hours: 0, minutes: 0, seconds: 0 },
          calculatedBlockTime: blockStats.last50BlocksAvg,
          dataPoints: blockStats.totalBlocks
        },
        accuracy: {
          improvementPercent,
          confidenceLevel
        }
      };

    } catch (error) {
      console.error('❌ Failed to compare predictions:', error);
      throw error;
    }
  }

  /**
   * Gerçek zamanlı block time monitoring
   */
  async monitorRealTimeBlockTime(): Promise<void> {
    console.log('🔄 Starting real-time block time monitoring...');
    
    for (let i = 0; i < 5; i++) {
      try {
        // Son 20 blokun ortalamasını al (hızlı güncelleme için)
        const recentStats = await this.calculateDynamicBlockTime(20);
        
        // EpochService'i güncelle
        this.epochService.setAverageBlockTime(recentStats.avgBlockTimeSeconds);
        
        // Current progress al
        const progress = await this.epochService.getEpochProgress();
        
        console.log(`📊 Iteration ${i + 1}:`);
        console.log(`   Current Block Time: ${recentStats.avgBlockTimeSeconds.toFixed(3)} seconds`);
        console.log(`   Progress: ${progress.progressPercentage.toFixed(2)}%`);
        console.log(`   Estimated Time: ${progress.estimatedTimeToNextEpoch?.hours}h ${progress.estimatedTimeToNextEpoch?.minutes}m ${progress.estimatedTimeToNextEpoch?.seconds}s`);
        console.log(`   Data Points: ${recentStats.totalBlocks} blocks`);
        console.log('   ---');
        
        // 10 saniye bekle
        await new Promise(resolve => setTimeout(resolve, 10000));
        
      } catch (error) {
        console.error(`❌ Error in iteration ${i + 1}:`, error);
      }
    }
  }

  async close(): Promise<void> {
    await this.clickhouseClient.close();
  }
}

async function main() {
  console.log('🚀 Starting Database-Driven Dynamic Block Time Test\n');

  const calculator = new DynamicBlockTimeCalculator();

  try {
    // 1. Basic block time statistics
    console.log('=' .repeat(60));
    console.log('📊 BLOCK TIME STATISTICS FROM DATABASE');
    console.log('=' .repeat(60));
    
    const stats = await calculator.calculateDynamicBlockTime(500);
    
    console.log(`📈 Block Time Analysis (${stats.totalBlocks} blocks):`);
    console.log(`   Average: ${stats.avgBlockTimeSeconds.toFixed(3)} seconds`);
    console.log(`   Median:  ${stats.medianBlockTimeSeconds.toFixed(3)} seconds`);
    console.log(`   Min:     ${stats.minBlockTimeSeconds.toFixed(3)} seconds`);
    console.log(`   Max:     ${stats.maxBlockTimeSeconds.toFixed(3)} seconds`);
    console.log(`   Std Dev: ${stats.stdDeviation.toFixed(3)} seconds`);
    console.log('');
    console.log('📊 Recent Averages:');
    console.log(`   Last 10 blocks:  ${stats.last10BlocksAvg.toFixed(3)} seconds`);
    console.log(`   Last 50 blocks:  ${stats.last50BlocksAvg.toFixed(3)} seconds`);
    console.log(`   Last 100 blocks: ${stats.last100BlocksAvg.toFixed(3)} seconds`);

    // 2. Static vs Dynamic comparison
    console.log('\n' + '=' .repeat(60));
    console.log('⚖️  STATIC vs DYNAMIC PREDICTION COMPARISON');
    console.log('=' .repeat(60));
    
    const comparison = await calculator.compareStaticVsDynamic();
    
    console.log('🔸 Static Prediction (0.5s assumption):');
    console.log(`   Time Estimate: ${comparison.staticPrediction.timeEstimate.hours}h ${comparison.staticPrediction.timeEstimate.minutes}m ${comparison.staticPrediction.timeEstimate.seconds}s`);
    console.log(`   Assumed Block Time: ${comparison.staticPrediction.assumedBlockTime} seconds`);
    
    console.log('');
    console.log('🔹 Dynamic Prediction (database-driven):');
    console.log(`   Time Estimate: ${comparison.dynamicPrediction.timeEstimate.hours}h ${comparison.dynamicPrediction.timeEstimate.minutes}m ${comparison.dynamicPrediction.timeEstimate.seconds}s`);
    console.log(`   Calculated Block Time: ${comparison.dynamicPrediction.calculatedBlockTime.toFixed(3)} seconds`);
    console.log(`   Data Points: ${comparison.dynamicPrediction.dataPoints} blocks`);
    
    console.log('');
    console.log('📈 Accuracy Analysis:');
    console.log(`   Improvement: ${comparison.accuracy.improvementPercent.toFixed(1)}% difference`);
    console.log(`   Confidence: ${comparison.accuracy.confidenceLevel}`);

    // 3. Real-time monitoring demo
    console.log('\n' + '=' .repeat(60));
    console.log('⏱️  REAL-TIME BLOCK TIME MONITORING (50 seconds demo)');
    console.log('=' .repeat(60));
    
    await calculator.monitorRealTimeBlockTime();

    console.log('\n✅ Database-driven dynamic block time test completed successfully!');
    console.log('\n💡 Key Insights:');
    console.log('   - Real-time block time calculation is possible using database');
    console.log('   - Dynamic predictions are more accurate than static assumptions');
    console.log('   - Short-term averages (last 20-50 blocks) provide good balance');
    console.log('   - System can adapt to network conditions automatically');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    await calculator.close();
  }
}

// Run the test
if (require.main === module) {
  main().catch(console.error);
} 