// Monad Validator Analytics - Redis Caching Client
// High-performance caching layer for sub-100ms query response times

import Redis from 'ioredis';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
  maxRetriesPerRequest: number;
  retryDelayOnFailover: number;
  maxMemoryPolicy: string;
  defaultTtl: number; // seconds
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  totalRequests: number;
  avgResponseTime: number;
}

export class MonadRedisClient {
  private client: Redis;
  private config: RedisConfig;
  private metrics: CacheMetrics;

  constructor(config: RedisConfig) {
    this.config = config;
    this.metrics = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      totalRequests: 0,
      avgResponseTime: 0
    };

    this.client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      keyPrefix: config.keyPrefix,
      maxRetriesPerRequest: config.maxRetriesPerRequest,
      lazyConnect: true
    });

    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.client.on('error', (error) => {
      console.error('Redis client error:', error);
    });

    this.client.on('connect', () => {
      console.log('Redis client connected');
    });

    this.client.on('ready', () => {
      console.log('Redis client ready');
    });
  }

  // =============================================
  // VALIDATOR RANKINGS CACHE
  // =============================================

  async cacheValidatorRankings(
    timeWindow: string,
    rankings: any[],
    ttl: number = this.config.defaultTtl
  ): Promise<void> {
    const key = `validator_rankings:${timeWindow}`;
    await this.client.setex(key, ttl, JSON.stringify(rankings));
  }

  async getValidatorRankings(timeWindow: string): Promise<any[] | null> {
    const startTime = Date.now();
    const key = `validator_rankings:${timeWindow}`;
    
    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;
      
      this.updateMetrics(cached !== null, responseTime);
      
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get validator rankings from cache: ${error}`);
      return null;
    }
  }

  // =============================================
  // NETWORK METRICS CACHE
  // =============================================

  async cacheNetworkMetrics(
    timeWindow: string,
    metrics: any,
    ttl: number = 60 // 1 minute for network metrics
  ): Promise<void> {
    const key = `network_metrics:${timeWindow}`;
    await this.client.setex(key, ttl, JSON.stringify(metrics));
  }

  async getNetworkMetrics(timeWindow: string): Promise<any | null> {
    const startTime = Date.now();
    const key = `network_metrics:${timeWindow}`;
    
    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;
      
      this.updateMetrics(cached !== null, responseTime);
      
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get network metrics from cache: ${error}`);
      return null;
    }
  }

  // =============================================
  // GEOGRAPHIC DISTRIBUTION CACHE
  // =============================================

  async cacheGeographicDistribution(
    distribution: any[],
    ttl: number = 300 // 5 minutes
  ): Promise<void> {
    const key = 'geographic_distribution';
    await this.client.setex(key, ttl, JSON.stringify(distribution));
  }

  async getGeographicDistribution(): Promise<any[] | null> {
    const startTime = Date.now();
    const key = 'geographic_distribution';
    
    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;
      
      this.updateMetrics(cached !== null, responseTime);
      
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get geographic distribution from cache: ${error}`);
      return null;
    }
  }

  // =============================================
  // VALIDATOR HISTORY CACHE
  // =============================================

  async cacheValidatorHistory(
    validatorId: string,
    hours: number,
    history: any[],
    ttl: number = 120 // 2 minutes
  ): Promise<void> {
    const key = `validator_history:${validatorId}:${hours}h`;
    await this.client.setex(key, ttl, JSON.stringify(history));
  }

  async getValidatorHistory(validatorId: string, hours: number): Promise<any[] | null> {
    const startTime = Date.now();
    const key = `validator_history:${validatorId}:${hours}h`;
    
    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;
      
      this.updateMetrics(cached !== null, responseTime);
      
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get validator history from cache: ${error}`);
      return null;
    }
  }

  // =============================================
  // HEALTH ALERTS CACHE
  // =============================================

  async cacheHealthAlerts(
    alerts: any[],
    ttl: number = 30 // 30 seconds for alerts
  ): Promise<void> {
    const key = 'health_alerts';
    await this.client.setex(key, ttl, JSON.stringify(alerts));
  }

  async getHealthAlerts(): Promise<any[] | null> {
    const startTime = Date.now();
    const key = 'health_alerts';
    
    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;
      
      this.updateMetrics(cached !== null, responseTime);
      
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get health alerts from cache: ${error}`);
      return null;
    }
  }

  // =============================================
  // REAL-TIME UPDATES USING PUB/SUB
  // =============================================

  async publishUpdate(channel: string, data: any): Promise<void> {
    try {
      await this.client.publish(channel, JSON.stringify(data));
    } catch (error) {
      console.error(`Failed to publish update to ${channel}: ${error}`);
    }
  }

  async subscribe(channel: string, callback: (data: any) => void): Promise<void> {
    const subscriber = this.client.duplicate();
    
    subscriber.subscribe(channel, (error, count) => {
      if (error) {
        console.error(`Failed to subscribe to ${channel}: ${error}`);
        return;
      }
      console.log(`Subscribed to ${count} channel(s): ${channel}`);
    });

    subscriber.on('message', (receivedChannel, message) => {
      if (receivedChannel === channel) {
        try {
          const data = JSON.parse(message);
          callback(data);
        } catch (error) {
          console.error(`Failed to parse message from ${channel}: ${error}`);
        }
      }
    });
  }

  // =============================================
  // AGGREGATED CACHE OPERATIONS
  // =============================================

  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number = this.config.defaultTtl
  ): Promise<T> {
    const startTime = Date.now();
    
    try {
      const cached = await this.client.get(key);
      
      if (cached) {
        const responseTime = Date.now() - startTime;
        this.updateMetrics(true, responseTime);
        return JSON.parse(cached);
      }

      // Cache miss - fetch fresh data
      const freshData = await fetcher();
      const responseTime = Date.now() - startTime;
      this.updateMetrics(false, responseTime);
      
      // Cache the fresh data
      await this.client.setex(key, ttl, JSON.stringify(freshData));
      
      return freshData;
    } catch (error) {
      console.error(`Cache getOrSet failed for key ${key}: ${error}`);
      // Fallback to fetcher if cache fails
      return await fetcher();
    }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(...keys);
        console.log(`Invalidated ${keys.length} keys matching pattern: ${pattern}`);
      }
    } catch (error) {
      console.error(`Failed to invalidate pattern ${pattern}: ${error}`);
    }
  }

  async warmupCache(): Promise<void> {
    console.log('Starting cache warmup...');
    
    try {
      // Warm up common queries that are frequently accessed
      const warmupTasks = [
        this.client.setex('warmup:validator_rankings:1h', 300, '[]'),
        this.client.setex('warmup:network_metrics:1h', 60, '{}'),
        this.client.setex('warmup:geographic_distribution', 300, '[]')
      ];
      
      await Promise.all(warmupTasks);
      console.log('Cache warmup completed');
    } catch (error) {
      console.error('Cache warmup failed:', error);
    }
  }

  // =============================================
  // CACHE PERFORMANCE MONITORING
  // =============================================

  private updateMetrics(isHit: boolean, responseTime: number): void {
    this.metrics.totalRequests++;
    
    if (isHit) {
      this.metrics.hits++;
    } else {
      this.metrics.misses++;
    }
    
    this.metrics.hitRate = (this.metrics.hits / this.metrics.totalRequests) * 100;
    
    // Simple moving average for response time
    this.metrics.avgResponseTime = 
      (this.metrics.avgResponseTime * (this.metrics.totalRequests - 1) + responseTime) / 
      this.metrics.totalRequests;
  }

  getCacheMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  async getCacheInfo(): Promise<any> {
    try {
      const info = await this.client.info('memory');
      const keyspace = await this.client.info('keyspace');
      
      return {
        memory: this.parseRedisInfo(info),
        keyspace: this.parseRedisInfo(keyspace),
        metrics: this.getCacheMetrics()
      };
    } catch (error) {
      console.error('Failed to get cache info:', error);
      return null;
    }
  }

  private parseRedisInfo(info: string): Record<string, string> {
    const result: Record<string, string> = {};
    
    info.split('\r\n').forEach(line => {
      if (line && line.includes(':')) {
        const [key, value] = line.split(':');
        result[key] = value;
      }
    });
    
    return result;
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      console.error('Redis ping failed:', error);
      return false;
    }
  }

  async flushAll(): Promise<void> {
    try {
      await this.client.flushall();
      console.log('All cache data cleared');
    } catch (error) {
      console.error('Failed to flush cache:', error);
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
      console.log('Redis connection closed');
    } catch (error) {
      console.error('Error closing Redis connection:', error);
    }
  }

  // =============================================
  // SPECIALIZED CACHING STRATEGIES
  // =============================================

  async cacheWithTags(key: string, data: any, tags: string[], ttl: number): Promise<void> {
    // Store the main data
    await this.client.setex(key, ttl, JSON.stringify(data));
    
    // Store tag mappings for invalidation
    for (const tag of tags) {
      await this.client.sadd(`tag:${tag}`, key);
      await this.client.expire(`tag:${tag}`, ttl + 60); // Tag lives slightly longer
    }
  }

  async invalidateByTag(tag: string): Promise<void> {
    try {
      const keys = await this.client.smembers(`tag:${tag}`);
      
      if (keys.length > 0) {
        await this.client.del(...keys);
        await this.client.del(`tag:${tag}`);
        console.log(`Invalidated ${keys.length} keys with tag: ${tag}`);
      }
    } catch (error) {
      console.error(`Failed to invalidate by tag ${tag}: ${error}`);
    }
  }

  async setExpiring(key: string, data: any, ttl: number): Promise<void> {
    await this.client.setex(key, ttl, JSON.stringify(data));
  }

  async incrementCounter(key: string, increment: number = 1): Promise<number> {
    return await this.client.incrby(key, increment);
  }

  async getCounter(key: string): Promise<number> {
    const value = await this.client.get(key);
    return value ? parseInt(value, 10) : 0;
  }

  // =============================================
  // TIP REVENUE CACHE METHODS
  // =============================================

  async cacheTipRevenueRankings(
    timeWindow: string,
    rankings: any[],
    ttl: number = 120 // 2 minutes
  ): Promise<void> {
    const key = `tip_revenue_rankings:${timeWindow}`;
    await this.client.setex(key, ttl, JSON.stringify(rankings));
  }

  async getTipRevenueRankings(timeWindow: string): Promise<any[] | null> {
    const startTime = Date.now();
    const key = `tip_revenue_rankings:${timeWindow}`;

    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;

      this.updateMetrics(cached !== null, responseTime);

      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get tip revenue rankings from cache: ${error}`);
      return null;
    }
  }

  async cacheTipRevenueSummary(
    summary: any,
    ttl: number = 60 // 1 minute
  ): Promise<void> {
    const key = 'tip_revenue_network_summary';
    await this.client.setex(key, ttl, JSON.stringify(summary));
  }

  async getTipRevenueSummary(): Promise<any | null> {
    const startTime = Date.now();
    const key = 'tip_revenue_network_summary';

    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;

      this.updateMetrics(cached !== null, responseTime);

      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get tip revenue summary from cache: ${error}`);
      return null;
    }
  }

  async cacheTipRevenueTrends(
    trends: any[],
    hours: number,
    ttl: number = 300 // 5 minutes
  ): Promise<void> {
    const key = `tip_revenue_trends:${hours}h`;
    await this.client.setex(key, ttl, JSON.stringify(trends));
  }

  async getTipRevenueTrends(hours: number): Promise<any[] | null> {
    const startTime = Date.now();
    const key = `tip_revenue_trends:${hours}h`;

    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;

      this.updateMetrics(cached !== null, responseTime);

      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get tip revenue trends from cache: ${error}`);
      return null;
    }
  }

  async cacheValidatorTipRevenue(
    validatorId: string,
    timeWindow: string,
    data: any,
    ttl: number = 120 // 2 minutes
  ): Promise<void> {
    const key = `validator_tip_revenue:${validatorId}:${timeWindow}`;
    await this.client.setex(key, ttl, JSON.stringify(data));
  }

  async getValidatorTipRevenue(validatorId: string, timeWindow: string): Promise<any | null> {
    const startTime = Date.now();
    const key = `validator_tip_revenue:${validatorId}:${timeWindow}`;

    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;

      this.updateMetrics(cached !== null, responseTime);

      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get validator tip revenue from cache: ${error}`);
      return null;
    }
  }

  async cacheValidatorTipHistory(
    validatorId: string,
    hours: number,
    history: any[],
    ttl: number = 300 // 5 minutes
  ): Promise<void> {
    const key = `validator_tip_history:${validatorId}:${hours}h`;
    await this.client.setex(key, ttl, JSON.stringify(history));
  }

  async getValidatorTipHistory(validatorId: string, hours: number): Promise<any[] | null> {
    const startTime = Date.now();
    const key = `validator_tip_history:${validatorId}:${hours}h`;

    try {
      const cached = await this.client.get(key);
      const responseTime = Date.now() - startTime;

      this.updateMetrics(cached !== null, responseTime);

      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error(`Failed to get validator tip history from cache: ${error}`);
      return null;
    }
  }
} 