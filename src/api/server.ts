// Monad Validator Analytics - Refactored API Server with MVC Architecture
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { DataIngestionService } from '../services/data-ingestion';
import { MonadClickHouseClient } from '../database/clickhouse-client';
import { MonadRedisClient } from '../cache/redis-client';
import { logger } from '../utils/logger';

// Import Controllers
import { HealthController } from './controllers/HealthController';
import { ValidatorController } from './controllers/ValidatorController';
import { NetworkController } from './controllers/NetworkController';
import { EventController } from './controllers/EventController';
import { AdminController } from './controllers/AdminController';
import { QueryPerformanceController } from './controllers/QueryPerformanceController';
import { EpochController } from './controllers/EpochController';
import { TransactionAnalyticsController } from './controllers/TransactionAnalyticsController';

// Import Database-Centric Staking Services
import { DatabaseStakingUpdateService, StakingUpdateConfig } from '../services/staking/DatabaseStakingUpdateService';

// Import Routes
import { createHealthRoutes } from './routes/health';
import { createValidatorRoutes } from './routes/validators';
import { createNetworkRoutes } from './routes/network';
import { createEventRoutes } from './routes/events';
import { createAdminRoutes } from './routes/admin';
import { createQueryPerformanceRoutes } from './routes/query-performance';
import { createDNSAnalyticsRoutes } from './routes/dns-analytics';
import { createEpochRoutes } from './routes/epoch';
import { createTransactionAnalyticsRoutes } from './routes/transaction-analytics';

export interface APIServerConfig {
  port: number;
  enableCors: boolean;
  enableCompression: boolean;
  enableRateLimit: boolean;
}

export interface APIError {
  error: string;
  message: string;
  statusCode: number;
  timestamp: string;
}

export class AnalyticsAPIServer {
  private app: express.Application;
  private config: APIServerConfig;
  private ingestionService: DataIngestionService;
  private clickhouseClient: MonadClickHouseClient;
  private redisClient: MonadRedisClient;
  private server: any;
  private stakingUpdateService: DatabaseStakingUpdateService | null = null;

  // Controllers
  private healthController!: HealthController;
  private validatorController!: ValidatorController;
  private networkController!: NetworkController;
  private eventController!: EventController;
  private adminController!: AdminController;
  private queryPerformanceController!: QueryPerformanceController;
  private epochController!: EpochController;
  private transactionAnalyticsController!: TransactionAnalyticsController;

  constructor(config: APIServerConfig, ingestionService: DataIngestionService) {
    this.config = config;
    this.ingestionService = ingestionService;
    this.app = express();
    
    // Initialize database clients
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

    this.redisClient = new MonadRedisClient({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'monad:',
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 1000,
      maxMemoryPolicy: 'allkeys-lru',
      defaultTtl: 300
    });

    // Initialize staking services
    this.initializeStakingServices();

    // Initialize controllers
    this.initializeControllers();

    // Setup middleware and routes
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  // =============================================
  // STAKING SERVICES INITIALIZATION
  // =============================================

  private initializeStakingServices(): void {
    // Only initialize staking services if RPC URL is provided
    const rpcUrl = process.env.MONAD_RPC_URL;
    if (!rpcUrl) {
      logger.warn('⚠️  MONAD_RPC_URL not configured, staking services will be disabled');
      return;
    }

    try {
      const stakingConfig: StakingUpdateConfig = {
        updateIntervalMs: parseInt(process.env.STAKING_UPDATE_INTERVAL_MS || '30000'), // 30 seconds default
        rpcUrl,
        clickhouseClient: this.clickhouseClient,
        redisClient: this.redisClient
      };

      this.stakingUpdateService = new DatabaseStakingUpdateService(stakingConfig);
      logger.info('✅ Staking services initialized');
    } catch (error) {
      logger.error('❌ Failed to initialize staking services:', error);
      logger.warn('⚠️  Continuing without staking integration');
    }
  }

  // =============================================
  // CONTROLLER INITIALIZATION
  // =============================================

  private initializeControllers(): void {
    this.healthController = new HealthController(
      this.ingestionService,
      this.clickhouseClient,
      this.redisClient
    );

    this.validatorController = new ValidatorController(
      this.clickhouseClient,
      this.redisClient,
      this.stakingUpdateService || undefined
    );

    this.networkController = new NetworkController(
      this.clickhouseClient,
      this.redisClient
    );

    this.eventController = new EventController(
      this.clickhouseClient,
      this.redisClient
    );

    this.adminController = new AdminController(
      this.ingestionService,
      this.clickhouseClient,
      this.redisClient
    );

    this.queryPerformanceController = new QueryPerformanceController(
      this.clickhouseClient
    );

    this.epochController = new EpochController(
      this.redisClient
    );

    this.transactionAnalyticsController = new TransactionAnalyticsController(
      this.clickhouseClient,
      this.redisClient
    );
  }

  // =============================================
  // MIDDLEWARE SETUP
  // =============================================

  private setupMiddleware(): void {
    // Security
    this.app.use(helmet());
    
    // Trust proxy for X-Forwarded-For headers (needed for rate limiting behind nginx/reverse proxy)
    this.app.set('trust proxy', 1);
    
    // CORS
    if (this.config.enableCors) {
      this.app.use(cors({
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
        credentials: true
      }));
    }

    // Compression
    if (this.config.enableCompression) {
      this.app.use(compression());
    }

    // Rate limiting
    if (this.config.enableRateLimit) {
      const limiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 1000, // limit each IP to 1000 requests per windowMs
        message: {
          error: 'Too many requests',
          message: 'Too many requests from this IP, please try again later.',
          statusCode: 429,
          timestamp: new Date().toISOString()
        },
        standardHeaders: true,
        legacyHeaders: false
      });
      this.app.use(limiter);
    }

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging middleware
    this.app.use(this.requestLoggingMiddleware.bind(this));

    // Request ID middleware
    this.app.use(this.requestIdMiddleware.bind(this));
  }

  // =============================================
  // ROUTES SETUP
  // =============================================

  private setupRoutes(): void {
    // Mount route modules
    this.app.use('/', createHealthRoutes(this.healthController));
    this.app.use('/', createValidatorRoutes(this.validatorController));
    this.app.use('/', createNetworkRoutes(this.networkController));
    this.app.use('/', createEventRoutes(this.eventController));
    this.app.use('/', createAdminRoutes(this.adminController));
    this.app.use('/', createQueryPerformanceRoutes(this.queryPerformanceController));
    this.app.use('/', createDNSAnalyticsRoutes(this.clickhouseClient, this.redisClient));
    this.app.use('/', createEpochRoutes(this.epochController));
    this.app.use('/api/transaction-analytics', createTransactionAnalyticsRoutes(this.transactionAnalyticsController));

    // API documentation endpoint
    this.app.get('/api/docs', this.handleApiDocs.bind(this));
    
    // API status endpoint
    this.app.get('/api/status', this.handleApiStatus.bind(this));
  }

  // =============================================
  // CUSTOM MIDDLEWARE
  // =============================================

  private requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();
    
    // Log request
    logger.info(`${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      contentLength: req.get('Content-Length'),
      timestamp: new Date().toISOString()
    });

    // Log response when finished
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      logger.info(`${req.method} ${req.path} - ${res.statusCode}`, {
        duration: `${duration}ms`,
        statusCode: res.statusCode,
        contentLength: res.get('Content-Length')
      });
    });

    next();
  }

  private requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = req.get('X-Request-ID') || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    res.setHeader('X-Request-ID', requestId);
    next();
  }

  // =============================================
  // UTILITY ENDPOINTS
  // =============================================

  private async handleApiDocs(req: Request, res: Response): Promise<void> {
    const apiDocs = {
      name: 'Monad Validator Analytics API',
      version: '1.0.0',
      description: 'High-performance validator analytics and monitoring system for Monad blockchain',
      baseUrl: `http://localhost:${this.config.port}`,
      endpoints: {
        health: {
          'GET /health': 'Basic health check',
          'GET /api/system/health': 'Detailed system health',
          'GET /api/system/metrics': 'System performance metrics',
          'GET /api/system/readiness': 'Kubernetes readiness probe',
          'GET /api/system/liveness': 'Kubernetes liveness probe'
        },
        validators: {
          'GET /api/validators/rankings': 'Validator performance rankings',
          'GET /api/validators/:id': 'Specific validator details',
          'GET /api/validators/:id/history': 'Validator historical data',
          'GET /api/validators/:id/performance': 'Validator performance metrics'
        },
        network: {
          'GET /api/network/summary': 'Network overview statistics',
          'GET /api/network/metrics': 'Network performance metrics',
          'GET /api/network/health-score': 'Overall network health score',
          'GET /api/geographic/distribution': 'Validator geographic distribution'
        },
        events: {
          'GET /api/events/recent': 'Recent consensus events',
          'GET /api/events/types': 'Event type statistics',
          'GET /api/events/timeline': 'Event timeline analysis',
          'GET /api/events/search': 'Search and filter events'
        },
        admin: {
          'POST /api/cache/flush': 'Flush cache (with optional pattern)',
          'POST /api/logs/process': 'Process log batch',
          'GET /api/maintenance/status': 'System maintenance status'
        },
        epoch: {
          'GET /api/epoch/progress': 'Current epoch progress with percentage and time estimates',
          'GET /api/epoch/info': 'Comprehensive epoch information',
          'GET /api/epoch/current': 'Current epoch number only',
          'GET /api/epoch/block/:blockNumber': 'Get epoch information for specific block',
          'GET /api/epoch/:epochNumber/blocks': 'Get block range for specific epoch',
          'GET /api/epoch/config': 'Epoch configuration settings'
        },
        transactionAnalytics: {
          'GET /api/transaction-analytics/validator/:id': 'Comprehensive transaction metrics for specific validator',
          'GET /api/transaction-analytics/validator/:id/trends': 'Validator transaction trends over time',
          'GET /api/transaction-analytics/network/summary': 'Network-wide transaction summary',
          'GET /api/transaction-analytics/network/trends': 'Network transaction trends over time',
          'GET /api/transaction-analytics/rankings': 'Validator rankings by transaction processing performance',
          'GET /api/transaction-analytics/tps': 'TPS analytics with time series data (hourly/daily/minute granularity)',
          'GET /api/transaction-analytics/tps/current': 'Real-time current TPS calculation',
          'GET /api/transaction-analytics/geographic': 'Transaction processing analytics by geographic location',
          'GET /api/transaction-analytics/providers': 'Transaction processing analytics by infrastructure provider'
        }
      },
      timestamp: new Date().toISOString()
    };

    res.json(apiDocs);
  }

  private async handleApiStatus(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.ingestionService.getSystemHealth();
      const metrics = this.ingestionService.getMetrics();
      
      res.json({
        api: {
          status: 'operational',
          version: '1.0.0',
          uptime: process.uptime(),
          timestamp: new Date().toISOString()
        },
        services: {
          database: health.database ? 'healthy' : 'unhealthy',
          cache: health.cache ? 'healthy' : 'unhealthy',
          ingestion: health.ingestion ? 'running' : 'stopped'
        },
        performance: {
          logsProcessed: metrics.totalLogsProcessed,
          successRate: 100 - metrics.errorRate,
          avgProcessingTime: metrics.avgProcessingTimeMs
        }
      });
    } catch (error) {
      res.status(500).json({
        api: {
          status: 'error',
          error: 'Failed to get status',
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  // =============================================
  // ERROR HANDLING
  // =============================================

  private setupErrorHandling(): void {
    // 404 handler
    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.originalUrl} not found`,
        statusCode: 404,
        timestamp: new Date().toISOString(),
        suggestion: 'Visit /api/docs for available endpoints'
      });
    });

    // Global error handler
    this.app.use((error: any, req: Request, res: Response, next: NextFunction) => {
      logger.error('API Error:', {
        error: error.message,
        stack: error.stack,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
      });
      
      const statusCode = error.statusCode || 500;
      
      res.status(statusCode).json({
        error: statusCode === 500 ? 'Internal Server Error' : error.name || 'API Error',
        message: error.message || 'An unexpected error occurred',
        statusCode,
        timestamp: new Date().toISOString(),
        requestId: res.get('X-Request-ID')
      });
    });
  }

  // =============================================
  // SERVER LIFECYCLE
  // =============================================

  async start(): Promise<void> {
    try {
      // Start staking service if available
      if (this.stakingUpdateService) {
        try {
          logger.info('🔄 Starting database staking service...');
          await this.stakingUpdateService.start();
          logger.info('✅ Staking service started');
        } catch (error) {
          logger.warn('⚠️  Failed to start staking service, continuing without staking integration:', error);
          this.stakingUpdateService = null; // Disable staking service
        }
      }

      this.server = this.app.listen(this.config.port, () => {
        logger.info(`🚀 Monad Analytics API Server started on port ${this.config.port}`);
        logger.info(`📊 API Documentation: http://localhost:${this.config.port}/api/docs`);
        logger.info(`💚 Health Check: http://localhost:${this.config.port}/health`);
        logger.info(`📈 System Status: http://localhost:${this.config.port}/api/status`);
        
        if (this.stakingUpdateService) {
          logger.info(`⚡ Staking Integration: GET /api/validators/staking/info`);
          logger.info(`🔄 Force Update: POST /api/validators/staking/update`);
        } else {
          logger.info(`⚠️  Staking integration disabled - configure MONAD_RPC_URL for full features`);
        }
      });

      // Set server timeout
      this.server.timeout = 30000; // 30 seconds
      
    } catch (error) {
      logger.error('Failed to start API server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Stop staking service if running
    if (this.stakingUpdateService) {
      this.stakingUpdateService.stop();
      logger.info('✅ Staking service stopped');
    }

    if (this.server) {
      this.server.close();
      logger.info('✅ API server stopped');
    }
    
    // Close database connections
    await this.clickhouseClient.close();
    await this.redisClient.close();
  }
} 