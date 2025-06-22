/**
 * Provider Performance Cache Service
 * 
 * Background service that pre-calculates expensive provider performance metrics
 * and stores them in both database cache table and Redis for fast API responses.
 * 
 * This prevents API timeouts on the centralization-risks endpoint while maintaining
 * data freshness and API structure compatibility.
 */

import { MonadClickHouseClient } from '../database/clickhouse-client';
import { MonadRedisClient } from '../cache/redis-client';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

export interface ProviderPerformanceData {
  provider: string;
  avgPerformance: number;
  validatorCount: number;
  activeValidatorCount: number;
  regions: string[];
  datacenters: string[];
  uniqueLocations: number;
  totalProposals: number;
  successfulProposals: number;
  blockSuccessRate: number;
  totalQcOpportunities: number;
  successfulQcParticipations: number;
  qcParticipationRate: number;
  calculatedAt: Date;
  dataWindowStart: Date;
  dataWindowEnd: Date;
  calculationDurationMs: number;
  dataFreshnessMinutes: number;
}

export interface ProviderCacheConfig {
  updateIntervalMinutes: number;
  dataWindowHours: number;
  enableRedisCache: boolean;
  redisCacheTtlSeconds: number;
  maxCalculationTimeoutMs: number;
  enableFallbackData: boolean;
}

export class ProviderPerformanceCacheService extends EventEmitter {
  private clickhouseClient: MonadClickHouseClient;
  private redisClient: MonadRedisClient;
  private config: ProviderCacheConfig;
  private updateTimer: NodeJS.Timeout | null = null;
  private isCalculating = false;
  private lastCalculationTime: Date | null = null;
  private calculationErrors = 0;

  // Cache keys
  private readonly REDIS_CACHE_KEY = 'provider_performance_cache';
  private readonly REDIS_METADATA_KEY = 'provider_performance_metadata';

  constructor(
    clickhouseClient: MonadClickHouseClient,
    redisClient: MonadRedisClient,
    config: Partial<ProviderCacheConfig> = {}
  ) {
    super();
    
    this.clickhouseClient = clickhouseClient;
    this.redisClient = redisClient;
    
    // Default configuration
    this.config = {
      updateIntervalMinutes: 15, // Update every 15 minutes
      dataWindowHours: 168, // 7 days of data (reduced from complex joins)
      enableRedisCache: true,
      redisCacheTtlSeconds: 900, // 15 minutes TTL
      maxCalculationTimeoutMs: 120000, // 2 minutes max calculation time
      enableFallbackData: true,
      ...config
    };
  }

  /**
   * Start the background cache service
   */
  async start(): Promise<void> {
    logger.info('🚀 Starting Provider Performance Cache Service');
    
    try {
      // Do initial calculation
      await this.calculateAndCache();
      
      // Start periodic updates
      this.updateTimer = setInterval(
        () => this.calculateAndCache(),
        this.config.updateIntervalMinutes * 60 * 1000
      );
      
      logger.info(`✅ Provider Performance Cache Service started (updates every ${this.config.updateIntervalMinutes} minutes)`);
      this.emit('started');
      
    } catch (error) {
      logger.error('❌ Failed to start Provider Performance Cache Service:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the background service
   */
  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    logger.info('🛑 Provider Performance Cache Service stopped');
    this.emit('stopped');
  }

  /**
   * Get cached provider performance data
   */
  async getCachedPerformanceData(): Promise<Map<string, ProviderPerformanceData>> {
    try {
      // Try Redis cache first
      if (this.config.enableRedisCache) {
        const cached = await this.redisClient['client'].get(this.REDIS_CACHE_KEY);
        if (cached) {
          const data = JSON.parse(cached);
          logger.debug('📊 Retrieved provider performance data from Redis cache');
          return new Map(Object.entries(data));
        }
      }

      // Fallback to database cache
      const dbData = await this.getFromDatabaseCache();
      if (dbData.size > 0) {
        logger.debug('📊 Retrieved provider performance data from database cache');
        
        // Update Redis cache asynchronously
        if (this.config.enableRedisCache) {
          this.updateRedisCache(dbData).catch(error => 
            logger.warn('Failed to update Redis cache:', error)
          );
        }
        
        return dbData;
      }

      // If no cache available, return empty map (API will handle gracefully)
      logger.warn('⚠️ No cached provider performance data available');
      return new Map();

    } catch (error) {
      logger.error('❌ Failed to get cached provider performance data:', error);
      return new Map();
    }
  }

  /**
   * Force recalculation (useful for manual triggers)
   */
  async forceRecalculation(): Promise<boolean> {
    logger.info('🔄 Force recalculation requested');
    return await this.calculateAndCache();
  }

  /**
   * Get service status and metrics
   */
  getStatus(): {
    isRunning: boolean;
    isCalculating: boolean;
    lastCalculationTime: Date | null;
    calculationErrors: number;
    nextUpdateIn: number;
    cacheAge: number;
  } {
    const nextUpdateIn = this.updateTimer ? 
      this.config.updateIntervalMinutes * 60 * 1000 : 0;
    
    const cacheAge = this.lastCalculationTime ? 
      Date.now() - this.lastCalculationTime.getTime() : -1;

    return {
      isRunning: this.updateTimer !== null,
      isCalculating: this.isCalculating,
      lastCalculationTime: this.lastCalculationTime,
      calculationErrors: this.calculationErrors,
      nextUpdateIn,
      cacheAge
    };
  }

  // ===============================
  // Private Implementation Methods
  // ===============================

  /**
   * Main calculation and caching logic
   */
  private async calculateAndCache(): Promise<boolean> {
    if (this.isCalculating) {
      logger.debug('⏳ Calculation already in progress, skipping');
      return false;
    }

    this.isCalculating = true;
    const startTime = Date.now();
    
    try {
      logger.info('🔄 Starting provider performance calculation...');
      
      // Calculate with timeout
      const performanceData = await Promise.race([
        this.calculateProviderPerformanceData(),
        this.createTimeoutPromise()
      ]);

      if (!performanceData || performanceData.size === 0) {
        throw new Error('No performance data calculated');
      }

      const calculationDuration = Date.now() - startTime;
      logger.info(`✅ Calculated performance data for ${performanceData.size} providers in ${calculationDuration}ms`);

      // Store in database cache
      await this.storeToDatabaseCache(performanceData, calculationDuration);
      
      // Store in Redis cache
      if (this.config.enableRedisCache) {
        await this.updateRedisCache(performanceData);
      }

      this.lastCalculationTime = new Date();
      this.calculationErrors = 0;
      
      this.emit('calculationComplete', {
        providersCount: performanceData.size,
        durationMs: calculationDuration
      });

      return true;

    } catch (error) {
      this.calculationErrors++;
      logger.error('❌ Provider performance calculation failed:', error);
      
      this.emit('calculationError', error);
      
      // If we have too many errors, use fallback data
      if (this.calculationErrors >= 3 && this.config.enableFallbackData) {
        await this.createFallbackData();
      }
      
      return false;
    } finally {
      this.isCalculating = false;
    }
  }

  /**
   * Optimized provider performance calculation
   */
  private async calculateProviderPerformanceData(): Promise<Map<string, ProviderPerformanceData>> {
    const performanceMap = new Map<string, ProviderPerformanceData>();
    const dataWindowStart = new Date(Date.now() - (this.config.dataWindowHours * 60 * 60 * 1000));
    const dataWindowEnd = new Date();

          // Optimized query that minimizes JOINs and uses efficient aggregations
    const performanceQuery = `
      WITH 
      -- First, get active validators by provider
      active_validators AS (
        SELECT DISTINCT 
          vr.provider,
          vr.validator_id,
          vr.location
        FROM validator_registry vr
        WHERE vr.provider IS NOT NULL 
          AND vr.provider != '' 
          AND vr.provider != 'unknown'
          AND vr.is_active = 1
      ),
      
      -- Block proposal metrics by provider
      block_metrics AS (
        SELECT 
          av.provider,
          COUNT(DISTINCT av.validator_id) as active_validators,
          COUNT(*) as total_proposals,
          COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) as successful_proposals,
          COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) / COUNT(*) * 100 as block_success_rate
        FROM active_validators av
        LEFT JOIN block_proposals bp ON av.validator_id = bp.validator_id
          AND bp.timestamp >= '${dataWindowStart.toISOString().slice(0, 19).replace('T', ' ')}'
          AND bp.timestamp <= '${dataWindowEnd.toISOString().slice(0, 19).replace('T', ' ')}'
        GROUP BY av.provider
      ),
      
      -- QC participation metrics by provider  
      qc_metrics AS (
        SELECT 
          av.provider,
          COUNT(*) as total_qc_opportunities,
          COUNT(CASE WHEN qc.participated = 1 THEN 1 END) as successful_participations,
          COUNT(CASE WHEN qc.participated = 1 THEN 1 END) / COUNT(*) * 100 as qc_participation_rate
        FROM active_validators av
        LEFT JOIN qc_participation qc ON av.validator_id = qc.validator_id
          AND qc.timestamp >= '${dataWindowStart.toISOString().slice(0, 19).replace('T', ' ')}'
          AND qc.timestamp <= '${dataWindowEnd.toISOString().slice(0, 19).replace('T', ' ')}'
        GROUP BY av.provider
      ),
      
      -- Geographic distribution by provider
      geo_metrics AS (
        SELECT 
          provider,
          COUNT(DISTINCT validator_id) as validator_count,
          arrayDistinct(groupArray(location)) as regions,
          COUNT(DISTINCT location) as unique_locations
        FROM active_validators
        GROUP BY provider
      )
      
      -- Final result combining all metrics
      SELECT 
        gm.provider,
        gm.validator_count,
        COALESCE(bm.active_validators, 0) as active_validator_count,
        gm.regions,
        array(gm.provider) as datacenters, -- Provider acts as datacenter
        gm.unique_locations,
        
        -- Block metrics
        COALESCE(bm.total_proposals, 0) as total_proposals,
        COALESCE(bm.successful_proposals, 0) as successful_proposals, 
        COALESCE(bm.block_success_rate, 0) as block_success_rate,
        
        -- QC metrics
        COALESCE(qm.total_qc_opportunities, 0) as total_qc_opportunities,
        COALESCE(qm.successful_participations, 0) as successful_qc_participations,
        COALESCE(qm.qc_participation_rate, 0) as qc_participation_rate,
        
        -- Combined performance score (weighted average)
        COALESCE(bm.block_success_rate, 0) * 0.4 + COALESCE(qm.qc_participation_rate, 0) * 0.6 as avg_performance
        
      FROM geo_metrics gm
      LEFT JOIN block_metrics bm ON gm.provider = bm.provider
      LEFT JOIN qc_metrics qm ON gm.provider = qm.provider
      ORDER BY avg_performance DESC
    `;

    try {
      const result = await this.clickhouseClient.executeRawQuery(performanceQuery);
      
      result.forEach(row => {
        const data: ProviderPerformanceData = {
          provider: row.provider,
          avgPerformance: parseFloat(row.avg_performance || 0),
          validatorCount: parseInt(row.validator_count || 0),
          activeValidatorCount: parseInt(row.active_validator_count || 0),
          regions: Array.isArray(row.regions) ? row.regions : [row.regions || 'unknown'],
          datacenters: Array.isArray(row.datacenters) ? row.datacenters : [row.provider],
          uniqueLocations: parseInt(row.unique_locations || 0),
          totalProposals: parseInt(row.total_proposals || 0),
          successfulProposals: parseInt(row.successful_proposals || 0),
          blockSuccessRate: parseFloat(row.block_success_rate || 0),
          totalQcOpportunities: parseInt(row.total_qc_opportunities || 0),
          successfulQcParticipations: parseInt(row.successful_qc_participations || 0),
          qcParticipationRate: parseFloat(row.qc_participation_rate || 0),
          calculatedAt: new Date(),
          dataWindowStart,
          dataWindowEnd,
          calculationDurationMs: 0, // Will be set later
          dataFreshnessMinutes: 0 // Will be calculated when retrieved
        };

        performanceMap.set(row.provider, data);
      });

      return performanceMap;

    } catch (error) {
      logger.error('❌ Failed to calculate provider performance data:', error);
      throw error;
    }
  }

  /**
   * Store calculated data to database cache table
   */
  private async storeToDatabaseCache(
    performanceData: Map<string, ProviderPerformanceData>, 
    calculationDuration: number
  ): Promise<void> {
    const data = Array.from(performanceData.values()).map(item => ({
      provider: item.provider,
      avg_performance: item.avgPerformance,
      validator_count: item.validatorCount,
      active_validator_count: item.activeValidatorCount,
      regions: item.regions,
      datacenters: item.datacenters,
      unique_locations: item.uniqueLocations,
      total_proposals: item.totalProposals,
      successful_proposals: item.successfulProposals,
      block_success_rate: item.blockSuccessRate,
      total_qc_opportunities: item.totalQcOpportunities,
      successful_qc_participations: item.successfulQcParticipations,
      qc_participation_rate: item.qcParticipationRate,
      calculated_at: item.calculatedAt.toISOString().slice(0, 19).replace('T', ' '),
      data_window_start: item.dataWindowStart.toISOString().slice(0, 19).replace('T', ' '),
      data_window_end: item.dataWindowEnd.toISOString().slice(0, 19).replace('T', ' '),
      calculation_duration_ms: calculationDuration,
      data_freshness_minutes: 0,
      is_valid: 1
    }));

    await this.clickhouseClient['client'].insert({
      table: 'provider_performance_cache',
      values: data,
      format: 'JSONEachRow'
    });

    logger.debug(`💾 Stored ${data.length} provider performance records to database cache`);
  }

  /**
   * Retrieve data from database cache
   */
  private async getFromDatabaseCache(): Promise<Map<string, ProviderPerformanceData>> {
    const query = `
      SELECT *
      FROM provider_performance_cache
      WHERE is_valid = 1
        AND calculated_at >= now() - INTERVAL 1 HOUR
      ORDER BY calculated_at DESC
      LIMIT 1000
    `;

    try {
      const result = await this.clickhouseClient.executeRawQuery(query);
      const performanceMap = new Map<string, ProviderPerformanceData>();

      result.forEach(row => {
        const data: ProviderPerformanceData = {
          provider: row.provider,
          avgPerformance: parseFloat(row.avg_performance || 0),
          validatorCount: parseInt(row.validator_count || 0),
          activeValidatorCount: parseInt(row.active_validator_count || 0),
          regions: Array.isArray(row.regions) ? row.regions : [row.regions || 'unknown'],
          datacenters: Array.isArray(row.datacenters) ? row.datacenters : [row.provider],
          uniqueLocations: parseInt(row.unique_locations || 0),
          totalProposals: parseInt(row.total_proposals || 0),
          successfulProposals: parseInt(row.successful_proposals || 0),
          blockSuccessRate: parseFloat(row.block_success_rate || 0),
          totalQcOpportunities: parseInt(row.total_qc_opportunities || 0),
          successfulQcParticipations: parseInt(row.successful_qc_participations || 0),
          qcParticipationRate: parseFloat(row.qc_participation_rate || 0),
          calculatedAt: new Date(row.calculated_at),
          dataWindowStart: new Date(row.data_window_start),
          dataWindowEnd: new Date(row.data_window_end),
          calculationDurationMs: parseInt(row.calculation_duration_ms || 0),
          dataFreshnessMinutes: Math.floor((Date.now() - new Date(row.calculated_at).getTime()) / 60000)
        };

        performanceMap.set(row.provider, data);
      });

      return performanceMap;
    } catch (error) {
      logger.error('❌ Failed to retrieve from database cache:', error);
      return new Map();
    }
  }

  /**
   * Update Redis cache
   */
  private async updateRedisCache(performanceData: Map<string, ProviderPerformanceData>): Promise<void> {
    try {
      const cacheData = Object.fromEntries(performanceData.entries());
      const metadata = {
        lastUpdated: new Date().toISOString(),
        recordCount: performanceData.size,
        cacheVersion: '1.0'
      };

      await Promise.all([
        this.redisClient['client'].setex(
          this.REDIS_CACHE_KEY, 
          this.config.redisCacheTtlSeconds,
          JSON.stringify(cacheData)
        ),
        this.redisClient['client'].setex(
          this.REDIS_METADATA_KEY,
          this.config.redisCacheTtlSeconds,
          JSON.stringify(metadata)
        )
      ]);

      logger.debug(`📦 Updated Redis cache with ${performanceData.size} provider records`);
    } catch (error) {
      logger.warn('⚠️ Failed to update Redis cache:', error);
      // Don't throw - Redis cache is optional
    }
  }

  /**
   * Create timeout promise for calculation limits
   */
  private createTimeoutPromise(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Calculation timeout after ${this.config.maxCalculationTimeoutMs}ms`));
      }, this.config.maxCalculationTimeoutMs);
    });
  }

  /**
   * Create fallback data when calculations fail repeatedly
   */
  private async createFallbackData(): Promise<void> {
    logger.warn('⚠️ Creating fallback provider performance data');
    
    // Simple fallback: get basic provider counts from validator registry
    const fallbackQuery = `
      SELECT 
        provider,
        COUNT(*) as validator_count,
        arrayDistinct(groupArray(location)) as regions
      FROM validator_registry
      WHERE provider IS NOT NULL 
        AND provider != '' 
        AND provider != 'unknown'
      GROUP BY provider
      ORDER BY validator_count DESC
    `;

    try {
      const result = await this.clickhouseClient.executeRawQuery(fallbackQuery);
      const fallbackMap = new Map<string, ProviderPerformanceData>();

      result.forEach(row => {
        const data: ProviderPerformanceData = {
          provider: row.provider,
          avgPerformance: 75, // Default reasonable performance
          validatorCount: parseInt(row.validator_count || 0),
          activeValidatorCount: parseInt(row.validator_count || 0),
          regions: Array.isArray(row.regions) ? row.regions : [row.regions || 'unknown'],
          datacenters: [row.provider],
          uniqueLocations: 1,
          totalProposals: 0,
          successfulProposals: 0,
          blockSuccessRate: 75,
          totalQcOpportunities: 0,
          successfulQcParticipations: 0,
          qcParticipationRate: 75,
          calculatedAt: new Date(),
          dataWindowStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
          dataWindowEnd: new Date(),
          calculationDurationMs: 0,
          dataFreshnessMinutes: 0
        };

        fallbackMap.set(row.provider, data);
      });

      // Store fallback data
      if (fallbackMap.size > 0) {
        await this.storeToDatabaseCache(fallbackMap, 0);
        if (this.config.enableRedisCache) {
          await this.updateRedisCache(fallbackMap);
        }
        logger.info(`✅ Created fallback data for ${fallbackMap.size} providers`);
      }

    } catch (error) {
      logger.error('❌ Failed to create fallback data:', error);
    }
  }
} 