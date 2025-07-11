// Monad Validator Analytics - Admin Controller
import { Request, Response } from 'express';
import { DataIngestionService } from '../../services/data-ingestion';
import { MonadClickHouseClient } from '../../database/clickhouse-client';
import { MonadRedisClient } from '../../cache/redis-client';
import { DomainExtractor } from '../../services/dns/DomainExtractor';
import { KeybaseService } from '../../services/keybase';
import { logger } from '../../utils/logger';

export class AdminController {
  private keybaseService: KeybaseService;

  constructor(
    private ingestionService: DataIngestionService,
    private clickhouseClient: MonadClickHouseClient,
    private redisClient: MonadRedisClient
  ) {
    this.keybaseService = new KeybaseService();
  }

  // =============================================
  // CACHE MANAGEMENT
  // =============================================

  async flushCache(req: Request, res: Response): Promise<void> {
    try {
      const pattern = req.body.pattern || '*';
      let keysDeleted = 0;
      
      if (pattern === '*') {
        // Flush all Redis data
        await this.redisClient.flushAll();
        res.json({
          success: true,
          message: 'All cache data cleared',
          pattern,
          timestamp: new Date().toISOString()
        });
      } else {
        // Delete keys matching pattern
        await this.redisClient.invalidatePattern(pattern);
        res.json({
          success: true,
          message: `Cache pattern '${pattern}' cleared`,
          pattern,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error('Failed to flush cache:', error);
      res.status(500).json({
        error: 'Failed to flush cache',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async clearValidatorCaches(req: Request, res: Response): Promise<void> {
    try {
      // Clear all validator-related cache entries
      const patterns = [
        'validator_rankings:*',
        'validator_details:*',
        'validator_history:*',
        'validator_*'
      ];
      
             for (const pattern of patterns) {
         await this.redisClient.invalidatePattern(pattern);
         logger.info(`Cleared cache keys matching pattern: ${pattern}`);
       }

       // Also optimize the validator registry table to merge duplicates
       logger.info('🔧 Optimizing validator_registry table...');
       await this.clickhouseClient.executeCommand('OPTIMIZE TABLE validator_registry FINAL');
       logger.info('✅ Validator registry table optimized');
       
       res.json({
         success: true,
         message: `Cleared validator cache entries and optimized database table`,
         patternsCleared: patterns,
         timestamp: new Date().toISOString()
       });
    } catch (error) {
      logger.error('Failed to clear validator caches:', error);
      res.status(500).json({
        error: 'Failed to clear validator caches',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async getCacheStats(req: Request, res: Response): Promise<void> {
    try {
      const cacheInfo = await this.redisClient.getCacheInfo();
      const cacheMetrics = this.redisClient.getCacheMetrics();
      
      res.json({
        cache_info: cacheInfo,
        cache_metrics: cacheMetrics,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get cache stats:', error);
      res.status(500).json({
        error: 'Failed to get cache stats',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async warmupCache(req: Request, res: Response): Promise<void> {
    try {
      await this.redisClient.warmupCache();
      
      res.json({
        success: true,
        message: 'Cache warmup completed successfully',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to warmup cache:', error);
      res.status(500).json({
        error: 'Failed to warmup cache',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // LOG PROCESSING MANAGEMENT
  // =============================================

  async processLogs(req: Request, res: Response): Promise<void> {
    try {
      const { logLines } = req.body;
      
      if (!logLines || !Array.isArray(logLines)) {
        res.status(400).json({
          error: 'Invalid input',
          message: 'logLines array is required in request body',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (logLines.length > 10000) {
        res.status(400).json({
          error: 'Batch too large',
          message: 'Maximum 10,000 log lines per batch',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const startTime = Date.now();
      await this.ingestionService.ingestBatch(logLines);
      const processingTime = Date.now() - startTime;
      
      logger.info(`Processed ${logLines.length} log lines in ${processingTime}ms`);
      
      res.json({
        success: true,
        message: `Successfully processed ${logLines.length} log lines`,
        processing_time_ms: processingTime,
        logs_processed: logLines.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to process logs:', error);
      res.status(500).json({
        error: 'Failed to process logs',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async getIngestionStatus(req: Request, res: Response): Promise<void> {
    try {
      const isRunning = this.ingestionService.isServiceRunning();
      const queueSize = this.ingestionService.getQueueSize();
      const metrics = this.ingestionService.getMetrics();
      
      res.json({
        status: isRunning ? 'running' : 'stopped',
        queue_size: queueSize,
        metrics,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get ingestion status:', error);
      res.status(500).json({
        error: 'Failed to get ingestion status',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // DATABASE MANAGEMENT
  // =============================================

  async getDatabaseStats(req: Request, res: Response): Promise<void> {
    try {
      const tableStats = await this.clickhouseClient.getTableStats();
      
      // Get additional database metrics including new tables
      const query = `
        SELECT 
          formatReadableSize(sum(bytes_on_disk)) as total_size,
          sum(rows) as total_rows,
          count(*) as total_tables
        FROM system.parts 
        WHERE database = 'monad_analytics'
          AND active = 1
      `;

      // Get specific stats for our main tables
      const specificTablesQuery = `
        SELECT 
          table,
          formatReadableSize(sum(bytes_on_disk)) as table_size,
          sum(rows) as table_rows,
          count(*) as part_count
        FROM system.parts 
        WHERE database = 'monad_analytics'
          AND active = 1
          AND table IN ('block_proposals', 'qc_participation', 'raw_logs')
        GROUP BY table
        ORDER BY sum(bytes_on_disk) DESC
      `;

      const [result, specificResult] = await Promise.all([
        this.clickhouseClient.executeRawQuery(query),
        this.clickhouseClient.executeRawQuery(specificTablesQuery)
      ]);

      const dbMetrics = result;
      const specificStats = specificResult;
      
      res.json({
        database_metrics: dbMetrics[0],
        table_stats: tableStats,
        focused_tables: {
          block_proposals: specificStats.find(s => s.table === 'block_proposals') || { table_size: '0 B', table_rows: 0, part_count: 0 },
          qc_participation: specificStats.find(s => s.table === 'qc_participation') || { table_size: '0 B', table_rows: 0, part_count: 0 },
          raw_logs: specificStats.find(s => s.table === 'raw_logs') || { table_size: '0 B', table_rows: 0, part_count: 0 }
        },
        schema_version: 'v2_focused_tables',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get database stats:', error);
      res.status(500).json({
        error: 'Failed to get database stats',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async optimizeDatabase(req: Request, res: Response): Promise<void> {
    try {
      const tableName = req.query.table as string || 'block_proposals';
      
      // Validate table name to prevent SQL injection
      const validTables = ['block_proposals', 'qc_participation', 'raw_logs'];
      if (!validTables.includes(tableName)) {
        res.status(400).json({
          error: 'Invalid table name',
          message: `Table must be one of: ${validTables.join(', ')}`,
          timestamp: new Date().toISOString()
        });
        return;
      }
      
      // Run OPTIMIZE TABLE command for better performance
      const query = `OPTIMIZE TABLE ${tableName} FINAL`;
      
      await this.clickhouseClient.executeCommand(query);
      
      logger.info(`Database table ${tableName} optimized`);
      
      res.json({
        success: true,
        message: `Table ${tableName} optimized successfully`,
        available_tables: validTables,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to optimize database:', error);
      res.status(500).json({
        error: 'Failed to optimize database',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // MAINTENANCE OPERATIONS
  // =============================================

  async getMaintenanceStatus(req: Request, res: Response): Promise<void> {
    try {
      // Check various system health indicators
      const systemHealth = await this.ingestionService.getSystemHealth();
      const dbPing = await this.clickhouseClient.ping();
      const cachePing = await this.redisClient.ping();
      
      // Get disk usage and performance metrics
      const diskUsageQuery = `
        SELECT 
          formatReadableSize(free_space) as free_space_readable,
          formatReadableSize(total_space) as total_space_readable,
          free_space,
          total_space,
          round((total_space - free_space) / total_space * 100, 2) as disk_usage_percent
        FROM system.disks 
        WHERE name = 'default'
      `;

      const diskResult = await this.clickhouseClient.executeRawQuery(diskUsageQuery);

      const diskUsage = diskResult;
      
      const maintenanceStatus = {
        overall_health: dbPing && cachePing && systemHealth.database && systemHealth.cache ? 'healthy' : 'needs_attention',
        components: {
          database: {
            status: dbPing ? 'healthy' : 'unhealthy',
            connected: dbPing
          },
          cache: {
            status: cachePing ? 'healthy' : 'unhealthy',
            connected: cachePing,
            metrics: systemHealth.cacheMetrics
          },
          ingestion: {
            status: systemHealth.ingestion ? 'running' : 'stopped',
            metrics: systemHealth.ingestion
          },
          disk: diskUsage[0] || null
        },
        recommendations: this.getMaintenanceRecommendations(systemHealth, diskUsage[0]),
        timestamp: new Date().toISOString()
      };

      res.json(maintenanceStatus);
    } catch (error) {
      logger.error('Failed to get maintenance status:', error);
      res.status(500).json({
        error: 'Failed to get maintenance status',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async performMaintenance(req: Request, res: Response): Promise<void> {
    try {
      const { operation } = req.body;
      
      const validOperations = ['optimize_db', 'clear_old_data', 'warmup_cache', 'vacuum_logs'];
      
      if (!operation || !validOperations.includes(operation)) {
        res.status(400).json({
          error: 'Invalid operation',
          message: `Operation must be one of: ${validOperations.join(', ')}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      let result: any = {};
      const startTime = Date.now();

      switch (operation) {
        case 'optimize_db':
          // Optimize all main tables
          await Promise.all([
            this.clickhouseClient.executeCommand('OPTIMIZE TABLE block_proposals FINAL'),
            this.clickhouseClient.executeCommand('OPTIMIZE TABLE qc_participation FINAL'),
            this.clickhouseClient.executeCommand('OPTIMIZE TABLE raw_logs FINAL'),
          ]);
          result.message = 'All main tables optimized successfully (block_proposals, qc_participation, raw_logs)';
          break;

        case 'clear_old_data':
          const retentionDays = req.body.retention_days || 30;
          await Promise.all([
            this.clickhouseClient.executeCommand(`ALTER TABLE block_proposals DELETE WHERE timestamp < now() - INTERVAL ${retentionDays} DAY`),
            this.clickhouseClient.executeCommand(`ALTER TABLE qc_participation DELETE WHERE timestamp < now() - INTERVAL ${retentionDays} DAY`),
            this.clickhouseClient.executeCommand(`ALTER TABLE raw_logs DELETE WHERE timestamp < now() - INTERVAL ${retentionDays} DAY`),
          ]);
          result.message = `Old data cleared from all tables (older than ${retentionDays} days)`;
          break;

        case 'warmup_cache':
          await this.redisClient.warmupCache();
          result.message = 'Cache warmed up successfully';
          break;

        case 'vacuum_logs':
          // Clean up any orphaned raw logs that weren't processed
          await this.clickhouseClient.executeCommand(`ALTER TABLE raw_logs DELETE WHERE parsing_status = 'failed' AND parsed_at < now() - INTERVAL 7 DAY`);
          result.message = 'Failed raw logs cleaned up successfully';
          break;
      }

      const duration = Date.now() - startTime;
      
      res.json({
        success: true,
        operation,
        duration_ms: duration,
        ...result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to perform maintenance:', error);
      res.status(500).json({
        error: 'Failed to perform maintenance',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // DOMAIN MAPPING MANAGEMENT
  // =============================================

  async getDomainMappings(req: Request, res: Response): Promise<void> {
    try {
      const mappings = DomainExtractor.getCustomMappings();
      const mappingArray = Array.from(mappings.entries()).map(([hostname, validatorName]) => ({
        hostname,
        validatorName
      }));

      res.json({
        mappings: mappingArray,
        count: mappingArray.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get domain mappings:', error);
      res.status(500).json({
        error: 'Failed to get domain mappings',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async addDomainMapping(req: Request, res: Response): Promise<void> {
    try {
      const { hostname, validatorName } = req.body;

      if (!hostname || !validatorName) {
        res.status(400).json({
          error: 'Missing required fields',
          message: 'Both hostname and validatorName are required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Validate hostname format
      if (typeof hostname !== 'string' || hostname.trim().length === 0) {
        res.status(400).json({
          error: 'Invalid hostname',
          message: 'Hostname must be a non-empty string',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Validate validator name
      if (typeof validatorName !== 'string' || validatorName.trim().length === 0) {
        res.status(400).json({
          error: 'Invalid validator name',
          message: 'Validator name must be a non-empty string',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Check if mapping already exists
      const existingMapping = DomainExtractor.hasCustomMapping(hostname);
      
      DomainExtractor.addCustomMapping(hostname, validatorName);
      
      // Clear relevant cache entries to ensure new mapping takes effect
      await this.redisClient.invalidatePattern('validator_*');
      
      logger.info(`Domain mapping added: ${hostname} -> ${validatorName}`);

      res.json({
        success: true,
        message: `Domain mapping ${existingMapping ? 'updated' : 'added'} successfully`,
        mapping: {
          hostname: hostname.toLowerCase().trim(),
          validatorName: validatorName.trim()
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to add domain mapping:', error);
      res.status(500).json({
        error: 'Failed to add domain mapping',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async removeDomainMapping(req: Request, res: Response): Promise<void> {
    try {
      const { hostname } = req.params;

      if (!hostname) {
        res.status(400).json({
          error: 'Missing hostname',
          message: 'Hostname parameter is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const removed = DomainExtractor.removeCustomMapping(hostname);

      if (!removed) {
        res.status(404).json({
          error: 'Mapping not found',
          message: `No custom mapping found for hostname: ${hostname}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Clear relevant cache entries
      await this.redisClient.invalidatePattern('validator_*');

      logger.info(`Domain mapping removed: ${hostname}`);

      res.json({
        success: true,
        message: `Domain mapping for ${hostname} removed successfully`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to remove domain mapping:', error);
      res.status(500).json({
        error: 'Failed to remove domain mapping',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async checkDomainMapping(req: Request, res: Response): Promise<void> {
    try {
      const { hostname } = req.params;

      if (!hostname) {
        res.status(400).json({
          error: 'Missing hostname',
          message: 'Hostname parameter is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const hasMapping = DomainExtractor.hasCustomMapping(hostname);
      const extractor = new DomainExtractor();
      const extractedName = extractor.extractValidatorName(hostname);

      res.json({
        hostname,
        hasCustomMapping: hasMapping,
        extractedValidatorName: extractedName,
        mappingType: hasMapping ? 'custom' : 'default_extraction',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to check domain mapping:', error);
      res.status(500).json({
        error: 'Failed to check domain mapping',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // KEYBASE ID MANAGEMENT
  // =============================================

  async getKeybaseMappings(req: Request, res: Response): Promise<void> {
    try {
      const query = `
        SELECT 
          validator_id,
          keybase_id,
          keybase_logo_url,
          validator_name,
          last_updated
        FROM validator_registry
        WHERE keybase_id != '' AND keybase_id IS NOT NULL
        ORDER BY last_updated DESC
      `;

      const mappings = await this.clickhouseClient.executeRawQuery(query);

      res.json({
        mappings: mappings.map(m => ({
          validatorId: m.validator_id,
          keybaseId: m.keybase_id,
          logoUrl: m.keybase_logo_url,
          validatorName: m.validator_name,
          lastUpdated: m.last_updated
        })),
        count: mappings.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get keybase mappings:', error);
      res.status(500).json({
        error: 'Failed to get keybase mappings',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async addKeybaseMapping(req: Request, res: Response): Promise<void> {
    try {
      const { validatorId, keybaseId } = req.body;

      if (!validatorId || !keybaseId) {
        res.status(400).json({
          error: 'Missing required fields',
          message: 'Both validatorId and keybaseId are required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Validate validator ID format
      if (typeof validatorId !== 'string' || validatorId.trim().length === 0) {
        res.status(400).json({
          error: 'Invalid validator ID',
          message: 'Validator ID must be a non-empty string',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Validate keybase ID format
      if (typeof keybaseId !== 'string' || keybaseId.trim().length === 0) {
        res.status(400).json({
          error: 'Invalid keybase ID',
          message: 'Keybase ID must be a non-empty string',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Check if validator exists
      const validatorQuery = `
        SELECT validator_id, validator_name
        FROM validator_registry
        WHERE validator_id = '${validatorId}'
        ORDER BY last_updated DESC
        LIMIT 1
      `;

      const validators = await this.clickhouseClient.executeRawQuery(validatorQuery);
      
      if (validators.length === 0) {
        res.status(404).json({
          error: 'Validator not found',
          message: `No validator found with ID: ${validatorId}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Validate keybase ID exists (try as key suffix first, then as username)
      let isValidKeybaseId = await this.keybaseService.validateKeySuffix(keybaseId);
      let logoUrl: string | null = null;
      
      if (isValidKeybaseId) {
        // It's a key suffix, get logo URL using key suffix
        logoUrl = await this.keybaseService.getLogoUrlByKeySuffix(keybaseId);
      } else {
        // Try as username
        isValidKeybaseId = await this.keybaseService.validateUsername(keybaseId);
        if (isValidKeybaseId) {
          logoUrl = await this.keybaseService.getLogoUrl(keybaseId);
        }
      }
      
      if (!isValidKeybaseId) {
        res.status(400).json({
          error: 'Invalid keybase ID',
          message: `Keybase ID '${keybaseId}' does not exist or is not accessible`,
          timestamp: new Date().toISOString()
        });
        return;
      }
      
      // Update validator registry with keybase information using INSERT with ReplacingMergeTree
      const updateQuery = `
        INSERT INTO validator_registry 
        (validator_id, node_id, epoch, stake, position, is_active, dns_address, dns_host, dns_port, 
         validator_name, provider, location, country, datacenter, keybase_id, keybase_logo_url, 
         first_seen, last_updated)
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
          validator_name,
          provider,
          location,
          country,
          datacenter,
          '${keybaseId}',
          '${logoUrl || ''}',
          first_seen,
          now()
        FROM validator_registry
        WHERE validator_id = '${validatorId}'
        ORDER BY last_updated DESC
        LIMIT 1
      `;

      await this.clickhouseClient.executeCommand(updateQuery);
      
      // Force merge to remove duplicates
      await this.clickhouseClient.executeCommand('OPTIMIZE TABLE validator_registry FINAL');
      
      // Clear relevant cache entries
      await this.redisClient.invalidatePattern('validator_*');
      
      logger.info(`Keybase mapping added: ${validatorId} -> ${keybaseId}`);

      res.json({
        success: true,
        message: 'Keybase mapping added successfully',
        mapping: {
          validatorId: validatorId.trim(),
          keybaseId: keybaseId.trim(),
          logoUrl: logoUrl || null,
          validatorName: validators[0].validator_name
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to add keybase mapping:', error);
      res.status(500).json({
        error: 'Failed to add keybase mapping',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async removeKeybaseMapping(req: Request, res: Response): Promise<void> {
    try {
      const { validatorId } = req.params;

      if (!validatorId) {
        res.status(400).json({
          error: 'Missing validator ID',
          message: 'Validator ID parameter is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Check if mapping exists
      const checkQuery = `
        SELECT validator_id, keybase_id
        FROM validator_registry
        WHERE validator_id = '${validatorId}' AND keybase_id != '' AND keybase_id IS NOT NULL
        ORDER BY last_updated DESC
        LIMIT 1
      `;

      const existing = await this.clickhouseClient.executeRawQuery(checkQuery);
      
      if (existing.length === 0) {
        res.status(404).json({
          error: 'Mapping not found',
          message: `No keybase mapping found for validator: ${validatorId}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Remove keybase mapping by setting it to empty using INSERT with ReplacingMergeTree
      const removeQuery = `
        INSERT INTO validator_registry 
        (validator_id, node_id, epoch, stake, position, is_active, dns_address, dns_host, dns_port, 
         validator_name, provider, location, country, datacenter, keybase_id, keybase_logo_url, 
         first_seen, last_updated)
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
          validator_name,
          provider,
          location,
          country,
          datacenter,
          '',
          '',
          first_seen,
          now()
        FROM validator_registry
        WHERE validator_id = '${validatorId}'
        ORDER BY last_updated DESC
        LIMIT 1
      `;

      await this.clickhouseClient.executeCommand(removeQuery);
      
      // Force merge to remove duplicates
      await this.clickhouseClient.executeCommand('OPTIMIZE TABLE validator_registry FINAL');
      
      // Clear relevant cache entries
      await this.redisClient.invalidatePattern('validator_*');

      logger.info(`Keybase mapping removed: ${validatorId}`);

      res.json({
        success: true,
        message: `Keybase mapping for ${validatorId} removed successfully`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to remove keybase mapping:', error);
      res.status(500).json({
        error: 'Failed to remove keybase mapping',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async checkKeybaseMapping(req: Request, res: Response): Promise<void> {
    try {
      const { validatorId } = req.params;

      if (!validatorId) {
        res.status(400).json({
          error: 'Missing validator ID',
          message: 'Validator ID parameter is required',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const query = `
        SELECT 
          validator_id,
          keybase_id,
          keybase_logo_url,
          validator_name,
          last_updated
        FROM validator_registry
        WHERE validator_id = '${validatorId}'
        ORDER BY last_updated DESC
        LIMIT 1
      `;

      const results = await this.clickhouseClient.executeRawQuery(query);
      
      if (results.length === 0) {
        res.status(404).json({
          error: 'Validator not found',
          message: `No validator found with ID: ${validatorId}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      const validator = results[0];
      const hasKeybaseMapping = validator.keybase_id && validator.keybase_id !== '';

      res.json({
        validatorId,
        hasKeybaseMapping,
        keybaseId: validator.keybase_id || null,
        logoUrl: validator.keybase_logo_url || null,
        validatorName: validator.validator_name,
        lastUpdated: validator.last_updated,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to check keybase mapping:', error);
      res.status(500).json({
        error: 'Failed to check keybase mapping',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  async refreshKeybaseLogos(req: Request, res: Response): Promise<void> {
    try {
      const query = `
        SELECT DISTINCT keybase_id
        FROM validator_registry
        WHERE keybase_id != '' AND keybase_id IS NOT NULL
      `;

      const results = await this.clickhouseClient.executeRawQuery(query);
      const keybaseIds = results.map(r => r.keybase_id);

      if (keybaseIds.length === 0) {
        res.json({
          success: true,
          message: 'No keybase IDs found to refresh',
          refreshed: 0,
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.info(`Refreshing logos for ${keybaseIds.length} keybase IDs...`);

      let refreshedCount = 0;
      let errorCount = 0;

      // Process in batches to avoid overwhelming the API
      const batchSize = 5;
      for (let i = 0; i < keybaseIds.length; i += batchSize) {
        const batch = keybaseIds.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(async (keybaseId) => {
            try {
              // Try as key suffix first, then as username
              let logoUrl = await this.keybaseService.getLogoUrlByKeySuffix(keybaseId);
              
              if (!logoUrl) {
                logoUrl = await this.keybaseService.getLogoUrl(keybaseId);
              }
              
              if (logoUrl) {
                // Update logo URL in database using INSERT with ReplacingMergeTree
                const updateQuery = `
                  INSERT INTO validator_registry 
                  (validator_id, node_id, epoch, stake, position, is_active, dns_address, dns_host, dns_port, 
                   validator_name, provider, location, country, datacenter, keybase_id, keybase_logo_url, 
                   first_seen, last_updated)
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
                    validator_name,
                    provider,
                    location,
                    country,
                    datacenter,
                    keybase_id,
                    '${logoUrl}',
                    first_seen,
                    now()
                  FROM validator_registry
                  WHERE keybase_id = '${keybaseId}'
                  ORDER BY last_updated DESC
                  LIMIT 1
                `;

                await this.clickhouseClient.executeCommand(updateQuery);
                refreshedCount++;
              }
            } catch (error) {
              logger.warn(`Failed to refresh logo for ${keybaseId}:`, error);
              errorCount++;
            }
          })
        );

        // Add delay between batches
        if (i + batchSize < keybaseIds.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Clear cache
      await this.redisClient.invalidatePattern('validator_*');

      res.json({
        success: true,
        message: `Refreshed ${refreshedCount} keybase logos`,
        total: keybaseIds.length,
        refreshed: refreshedCount,
        errors: errorCount,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to refresh keybase logos:', error);
      res.status(500).json({
        error: 'Failed to refresh keybase logos',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
  }

  // =============================================
  // HELPER METHODS
  // =============================================

  private getMaintenanceRecommendations(systemHealth: any, diskUsage: any): string[] {
    const recommendations: string[] = [];

    // Database recommendations
    if (!systemHealth.database) {
      recommendations.push('Database connection issues detected - check ClickHouse service');
    }

    // Cache recommendations
    if (!systemHealth.cache) {
      recommendations.push('Cache connection issues detected - check Redis service');
    } else if (systemHealth.cacheMetrics.hitRate < 80) {
      recommendations.push('Cache hit rate is low - consider cache warmup or TTL optimization');
    }

    // Disk usage recommendations
    if (diskUsage && diskUsage.disk_usage_percent > 80) {
      recommendations.push('Disk usage is high - consider data cleanup or storage expansion');
    } else if (diskUsage && diskUsage.disk_usage_percent > 90) {
      recommendations.push('CRITICAL: Disk usage is very high - immediate cleanup required');
    }

    // Ingestion recommendations
    if (systemHealth.ingestion.errorRate > 5) {
      recommendations.push('High error rate in log ingestion - check log formats and processing');
    }

    if (recommendations.length === 0) {
      recommendations.push('System is operating normally - no maintenance required');
    }

    return recommendations;
  }
} 