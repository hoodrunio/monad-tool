import { Router } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { AnalyticsController } from '../controllers/AnalyticsController';
import { asyncHandler } from '../middleware/errorHandlers';

/**
 * Create analytics routes for transaction statistics and gas price tracking
 */
export function createAnalyticsRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();
  const analyticsController = new AnalyticsController(serviceContainer);

  /**
   * Transaction Analytics Routes
   */
  
  // GET /api/analytics/transactions/daily
  // Get daily transaction counts for charting
  router.get('/transactions/daily', asyncHandler(async (req, res) => {
    await analyticsController.getDailyTransactions(req, res);
  }));

  // GET /api/analytics/transactions/weekly  
  // Get weekly transaction counts aggregated from daily stats
  router.get('/transactions/weekly', asyncHandler(async (req, res) => {
    await analyticsController.getWeeklyTransactions(req, res);
  }));

  /**
   * Gas Price Analytics Routes
   */
  
  // GET /api/analytics/gas/current
  // Get current gas price and recommendations
  router.get('/gas/current', asyncHandler(async (req, res) => {
    await analyticsController.getCurrentGasPrice(req, res);
  }));

  // GET /api/analytics/gas/history
  // Get historical gas price data for charting
  router.get('/gas/history', asyncHandler(async (req, res) => {
    await analyticsController.getGasPriceHistory(req, res);
  }));

  /**
   * Documentation endpoint
   */
  router.get('/', (req, res) => {
    res.json({
      name: 'Monad Explorer Analytics API',
      version: '1.0.0',
      description: 'Transaction statistics and gas price tracking endpoints for UI charts and dashboards',
      endpoints: {
        'transactions': {
          'GET /analytics/transactions/daily': {
            description: 'Get daily transaction counts for chart visualization (newest to oldest)',
            parameters: {
              days: 'Number of days to include (1-365, default: 30)',
              startDate: 'Start date (YYYY-MM-DD format, optional)',
              endDate: 'End date (YYYY-MM-DD format, optional)'
            },
            response: {
              data: 'Array of daily transaction data points (newest first)',
              summary: 'Statistical summary (total, average, min, max)'
            }
          },
          'GET /analytics/transactions/weekly': {
            description: 'Get weekly transaction counts aggregated from daily data (newest to oldest)',
            parameters: {
              weeks: 'Number of weeks to include (1-52, default: 12)',
              startDate: 'Start date (YYYY-MM-DD format, optional)',
              endDate: 'End date (YYYY-MM-DD format, optional)'
            },
            response: {
              data: 'Array of weekly transaction data points (newest first)',
              summary: 'Statistical summary including weekly averages'
            }
          }
        },
        'gas': {
          'GET /analytics/gas/current': {
            description: 'Get current gas price and transaction fee recommendations',
            parameters: 'None',
            response: {
              current: 'Current gas price with timestamp',
              statistics: 'Gas price statistics (avg, median, min, max)',
              recommendations: 'Fee recommendations (slow, standard, fast, fastest)',
              metadata: 'Sample size and data quality information'
            }
          },
          'GET /analytics/gas/history': {
            description: 'Get historical gas price data for trend analysis (newest to oldest)',
            parameters: {
              days: 'Number of days to include (1-365, default: 30)',
              startDate: 'Start date (YYYY-MM-DD format, optional)',
              endDate: 'End date (YYYY-MM-DD format, optional)',
              granularity: 'Data granularity - "daily" (default)'
            },
            response: {
              data: 'Array of historical gas price data points (newest first)',
              analysis: 'Trend analysis including volatility and direction',
              period: 'Time period information'
            }
          }
        }
      },
      usage: {
        'daily_transactions_chart': 'GET /analytics/transactions/daily?days=30',
        'weekly_overview': 'GET /analytics/transactions/weekly?weeks=12',
        'current_gas_tracker': 'GET /analytics/gas/current',
        'gas_price_history': 'GET /analytics/gas/history?days=7'
      },
      features: [
        'Real-time gas price tracking',
        'Historical transaction volume analysis', 
        'Weekly and daily aggregations',
        'Gas price volatility analysis',
        'Transaction fee recommendations',
        'Chart-ready data formatting',
        'Flexible date range filtering',
        'Statistical summaries'
      ],
      dataSource: 'Aggregated from DailyStats and live Transaction data',
      caching: 'Smart caching with real-time current data',
      performance: 'Optimized queries using pre-aggregated daily statistics'
    });
  });

  return router;
} 