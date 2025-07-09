import { Request, Response } from 'express';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validatePaginationParams } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';

export class AnalyticsController {
  constructor(private readonly serviceContainer: ServiceContainer) {}

  /**
   * GET /api/analytics/transactions/daily
   * Get daily transaction counts for charts
   * FALLBACK: If DailyStats is empty, compute from Transaction table
   */
  public async getDailyTransactions(req: Request, res: Response): Promise<void> {
    const { 
      days = '30',
      startDate,
      endDate 
    } = req.query;

    try {
      const store = await this.serviceContainer.resolve<StoreAdapter>('store');
      
      // Validate days parameter
      const daysCount = parseInt(days as string, 10);
      if (isNaN(daysCount) || daysCount < 1 || daysCount > 365) {
        throw new ApiErrorResponse(
          'Invalid days parameter. Must be between 1 and 365',
          400,
          'INVALID_DAYS_PARAMETER'
        );
      }

      // Calculate date range
      let dateCondition: any;
      if (startDate && endDate) {
        dateCondition = Between(new Date(startDate as string), new Date(endDate as string));
      } else {
        const endDateObj = new Date();
        const startDateObj = new Date();
        startDateObj.setDate(endDateObj.getDate() - daysCount);
        dateCondition = Between(startDateObj, endDateObj);
      }

      // Try DailyStats first
      const dailyStats = await store.DailyStats.find({
        where: { date: dateCondition },
        order: { date: 'DESC' },
        select: ['date', 'transactionCount', 'blockCount', 'totalGasUsed', 'averageGasPrice']
      });

      let chartData: any[];
      let dataSource = 'pre-aggregated';

      if (dailyStats.length === 0) {
        // FALLBACK: Compute from Transaction table
        dataSource = 'real-time-computed';
        chartData = await this.computeDailyStatsFromTransactions(store, dateCondition);
      } else {
        // Use pre-aggregated data
        chartData = dailyStats.map((stat: any) => ({
          date: stat.date.toISOString().split('T')[0], // YYYY-MM-DD format
          transactionCount: stat.transactionCount,
          blockCount: stat.blockCount,
          totalGasUsed: stat.totalGasUsed.toString(),
          averageGasPrice: stat.averageGasPrice.toString()
        }));
      }

      // Calculate summary statistics
      const totalTransactions = chartData.reduce((sum: number, stat: any) => sum + stat.transactionCount, 0);
      const averageDaily = Math.round(totalTransactions / Math.max(chartData.length, 1));
      const maxDaily = chartData.length > 0 ? Math.max(...chartData.map((stat: any) => stat.transactionCount)) : 0;
      const minDaily = chartData.length > 0 ? Math.min(...chartData.map((stat: any) => stat.transactionCount)) : 0;

      successResponse(res, prepareForApiResponse({
        data: chartData,
        summary: {
          totalTransactions,
          averageDaily,
          maxDaily,
          minDaily,
          daysIncluded: chartData.length,
          periodStart: chartData[0]?.date || null,
          periodEnd: chartData[chartData.length - 1]?.date || null
        },
        dataSource: {
          type: dataSource,
          fallbackUsed: dataSource === 'real-time-computed',
          note: dataSource === 'real-time-computed' ? 'DailyStats table is empty, computed from Transaction table' : 'Using pre-aggregated DailyStats'
        }
      }), 'Daily transaction statistics retrieved successfully', 200, {
        dataPoints: chartData.length,
        period: `${daysCount} days`,
        dataSource
      });

    } catch (error) {
      throw new ApiErrorResponse(
        'Failed to retrieve daily transaction statistics',
        500,
        'DAILY_STATS_ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Compute daily stats from Transaction table (fallback when DailyStats is empty)
   */
  private async computeDailyStatsFromTransactions(store: StoreAdapter, dateCondition: any): Promise<any[]> {
    // Get all transactions in date range
    const transactions = await store.Transaction.find({
      where: { timestamp: dateCondition },
      select: ['timestamp', 'gasPrice', 'gasUsed', 'effectiveGasPrice', 'status'],
      order: { timestamp: 'DESC' }
    });

    if (transactions.length === 0) {
      return [];
    }

    // Group transactions by date
    const dailyGroups = new Map<string, any[]>();
    
    transactions.forEach((tx: any) => {
      const date = new Date(tx.timestamp);
      const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
      
      if (!dailyGroups.has(dateKey)) {
        dailyGroups.set(dateKey, []);
      }
      dailyGroups.get(dateKey)!.push(tx);
    });

    // Compute daily aggregations
    const chartData = Array.from(dailyGroups.entries()).map(([date, txs]) => {
      const successfulTxs = txs.filter((tx: any) => tx.status === 1);
      const totalGasUsed = successfulTxs.reduce((sum: bigint, tx: any) => {
        return sum + (tx.gasUsed || BigInt(0));
      }, BigInt(0));
      
      // Calculate average gas price
      const gasPrices = successfulTxs.map((tx: any) => tx.effectiveGasPrice || tx.gasPrice);
      const avgGasPrice = gasPrices.length > 0 
        ? gasPrices.reduce((sum: bigint, price: bigint) => sum + price, BigInt(0)) / BigInt(gasPrices.length)
        : BigInt(0);

      return {
        date,
        transactionCount: txs.length,
        blockCount: 0, // Cannot determine from Transaction table alone
        totalGasUsed: totalGasUsed.toString(),
        averageGasPrice: avgGasPrice.toString()
      };
    }).sort((a, b) => b.date.localeCompare(a.date));

    return chartData;
  }

  /**
   * GET /api/analytics/transactions/weekly
   * Get weekly transaction counts aggregated from daily stats
   * FALLBACK: If DailyStats is empty, compute from Transaction table
   */
  public async getWeeklyTransactions(req: Request, res: Response): Promise<void> {
    const { 
      weeks = '12',
      startDate,
      endDate 
    } = req.query;

    try {
      const store = await this.serviceContainer.resolve<StoreAdapter>('store');
      
      // Validate weeks parameter
      const weeksCount = parseInt(weeks as string, 10);
      if (isNaN(weeksCount) || weeksCount < 1 || weeksCount > 52) {
        throw new ApiErrorResponse(
          'Invalid weeks parameter. Must be between 1 and 52',
          400,
          'INVALID_WEEKS_PARAMETER'
        );
      }

      // Calculate date range
      let dateCondition: any;
      if (startDate && endDate) {
        dateCondition = Between(new Date(startDate as string), new Date(endDate as string));
      } else {
        const endDateObj = new Date();
        const startDateObj = new Date();
        startDateObj.setDate(endDateObj.getDate() - (weeksCount * 7));
        dateCondition = Between(startDateObj, endDateObj);
      }

      // Try DailyStats first
      let dailyStats = await store.DailyStats.find({
        where: { date: dateCondition },
        order: { date: 'DESC' },
        select: ['date', 'transactionCount', 'blockCount', 'totalGasUsed', 'averageGasPrice']
      });

      let dataSource = 'pre-aggregated';

             if (dailyStats.length === 0) {
         // FALLBACK: Compute from Transaction table
         dataSource = 'real-time-computed';
         const computedDaily = await this.computeDailyStatsFromTransactions(store, dateCondition);
         
         // Convert to expected format (cast as any to avoid type conflicts)
         dailyStats = computedDaily.map((stat: any) => ({
           date: new Date(stat.date),
           transactionCount: stat.transactionCount,
           blockCount: stat.blockCount,
           totalGasUsed: BigInt(stat.totalGasUsed),
           averageGasPrice: BigInt(stat.averageGasPrice)
         })) as any;
       }

      // Group by week (Monday to Sunday)
      const weeklyData = new Map<string, {
        weekStart: Date;
        weekEnd: Date;
        transactionCount: number;
        blockCount: number;
        totalGasUsed: bigint;
        gasDataPoints: bigint[];
        dayCount: number;
      }>();

      dailyStats.forEach((stat: any) => {
        // Get Monday of the week
        const date = new Date(stat.date);
        const day = date.getDay();
        const monday = new Date(date);
        monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1)); // Adjust for Sunday = 0
        
        const weekKey = monday.toISOString().split('T')[0];
        
        if (!weeklyData.has(weekKey)) {
          const sunday = new Date(monday);
          sunday.setDate(monday.getDate() + 6);
          
          weeklyData.set(weekKey, {
            weekStart: monday,
            weekEnd: sunday,
            transactionCount: 0,
            blockCount: 0,
            totalGasUsed: BigInt(0),
            gasDataPoints: [],
            dayCount: 0
          });
        }

        const weekData = weeklyData.get(weekKey)!;
        weekData.transactionCount += stat.transactionCount;
        weekData.blockCount += stat.blockCount;
        weekData.totalGasUsed += stat.totalGasUsed;
        weekData.gasDataPoints.push(stat.averageGasPrice);
        weekData.dayCount++;
      });

      // Convert to chart format
      const chartData = Array.from(weeklyData.entries())
        .map(([weekKey, data]) => ({
          weekStart: data.weekStart.toISOString().split('T')[0],
          weekEnd: data.weekEnd.toISOString().split('T')[0],
          week: `${data.weekStart.toISOString().split('T')[0]} to ${data.weekEnd.toISOString().split('T')[0]}`,
          transactionCount: data.transactionCount,
          blockCount: data.blockCount,
          totalGasUsed: data.totalGasUsed.toString(),
          averageGasPrice: data.gasDataPoints.length > 0 
            ? (data.gasDataPoints.reduce((sum, price) => sum + price, BigInt(0)) / BigInt(data.gasDataPoints.length)).toString()
            : '0',
          daysIncluded: data.dayCount
        }))
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

      // Calculate summary
      const totalTransactions = chartData.reduce((sum, week) => sum + week.transactionCount, 0);
      const averageWeekly = Math.round(totalTransactions / Math.max(chartData.length, 1));

      successResponse(res, prepareForApiResponse({
        data: chartData,
        summary: {
          totalTransactions,
          averageWeekly,
          weeksIncluded: chartData.length,
          periodStart: chartData[0]?.weekStart || null,
          periodEnd: chartData[chartData.length - 1]?.weekEnd || null
        },
        dataSource: {
          type: dataSource,
          fallbackUsed: dataSource === 'real-time-computed',
          note: dataSource === 'real-time-computed' ? 'DailyStats table is empty, computed from Transaction table' : 'Using pre-aggregated DailyStats'
        }
      }), 'Weekly transaction statistics retrieved successfully', 200, {
        dataPoints: chartData.length,
        period: `${weeksCount} weeks`,
        dataSource
      });

    } catch (error) {
      throw new ApiErrorResponse(
        'Failed to retrieve weekly transaction statistics',
        500,
        'WEEKLY_STATS_ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * GET /api/analytics/gas/current
   * Get current gas price from latest transactions
   */
  public async getCurrentGasPrice(req: Request, res: Response): Promise<void> {
    try {
      const store = await this.serviceContainer.resolve<StoreAdapter>('store');
      
      // Get latest transactions to calculate current gas price
      const latestTransactions = await store.Transaction.find({
        where: {
          gasPrice: MoreThanOrEqual(BigInt(0))
        },
        order: { timestamp: 'DESC' },
        take: 100, // Sample from last 100 transactions
        select: ['gasPrice', 'effectiveGasPrice', 'maxFeePerGas', 'timestamp', 'status']
      });

      if (latestTransactions.length === 0) {
        throw new ApiErrorResponse(
          'No recent transactions found',
          404,
          'NO_RECENT_TRANSACTIONS'
        );
      }

      // Calculate gas price statistics
      const successfulTxs = latestTransactions.filter(tx => tx.status === 1);
      const gasPrices = successfulTxs.map(tx => tx.effectiveGasPrice || tx.gasPrice);
      const gasPricesAsNumbers = gasPrices.map(price => Number(price));

      gasPricesAsNumbers.sort((a, b) => a - b);

      const current = gasPricesAsNumbers[gasPricesAsNumbers.length - 1] || 0;
      const average = gasPricesAsNumbers.reduce((sum, price) => sum + price, 0) / gasPricesAsNumbers.length;
      const median = gasPricesAsNumbers[Math.floor(gasPricesAsNumbers.length / 2)] || 0;
      const min = gasPricesAsNumbers[0] || 0;
      const max = gasPricesAsNumbers[gasPricesAsNumbers.length - 1] || 0;

      // Calculate percentiles for gas price recommendations
      const p25 = gasPricesAsNumbers[Math.floor(gasPricesAsNumbers.length * 0.25)] || 0;
      const p75 = gasPricesAsNumbers[Math.floor(gasPricesAsNumbers.length * 0.75)] || 0;
      const p90 = gasPricesAsNumbers[Math.floor(gasPricesAsNumbers.length * 0.90)] || 0;

      successResponse(res, prepareForApiResponse({
        current: {
          gasPrice: current.toString(),
          timestamp: latestTransactions[0].timestamp,
          unit: 'wei'
        },
        statistics: {
          average: Math.round(average).toString(),
          median: median.toString(),
          min: min.toString(),
          max: max.toString()
        },
        recommendations: {
          slow: p25.toString(),
          standard: median.toString(),
          fast: p75.toString(),
          fastest: p90.toString()
        },
        metadata: {
          sampleSize: successfulTxs.length,
          timeRange: `Last ${latestTransactions.length} transactions`,
          lastUpdate: latestTransactions[0].timestamp
        }
      }), 'Current gas price retrieved successfully', 200, {
        sampleTransactions: successfulTxs.length
      });

    } catch (error) {
      throw new ApiErrorResponse(
        'Failed to retrieve current gas price',
        500,
        'GAS_PRICE_ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * GET /api/analytics/gas/history
   * Get historical gas price data from daily stats
   * FALLBACK: If DailyStats is empty, compute from Transaction table
   */
  public async getGasPriceHistory(req: Request, res: Response): Promise<void> {
    const { 
      days = '30',
      startDate,
      endDate,
      granularity = 'daily' // daily, hourly (if we implement hourly stats later)
    } = req.query;

    try {
      const store = await this.serviceContainer.resolve<StoreAdapter>('store');
      
      // Validate days parameter
      const daysCount = parseInt(days as string, 10);
      if (isNaN(daysCount) || daysCount < 1 || daysCount > 365) {
        throw new ApiErrorResponse(
          'Invalid days parameter. Must be between 1 and 365',
          400,
          'INVALID_DAYS_PARAMETER'
        );
      }

      // Calculate date range
      let dateCondition: any;
      if (startDate && endDate) {
        dateCondition = Between(new Date(startDate as string), new Date(endDate as string));
      } else {
        const endDateObj = new Date();
        const startDateObj = new Date();
        startDateObj.setDate(endDateObj.getDate() - daysCount);
        dateCondition = Between(startDateObj, endDateObj);
      }

      // Try DailyStats first
      let dailyStats = await store.DailyStats.find({
        where: { date: dateCondition },
        order: { date: 'DESC' },
        select: ['date', 'averageGasPrice', 'totalGasUsed', 'transactionCount']
      });

      let dataSource = 'pre-aggregated';

             if (dailyStats.length === 0) {
         // FALLBACK: Compute from Transaction table
         dataSource = 'real-time-computed';
         const computedDaily = await this.computeDailyStatsFromTransactions(store, dateCondition);
         
         // Convert to expected format (cast as any to avoid type conflicts)
         dailyStats = computedDaily.map((stat: any) => ({
           date: new Date(stat.date),
           averageGasPrice: BigInt(stat.averageGasPrice),
           totalGasUsed: BigInt(stat.totalGasUsed),
           transactionCount: stat.transactionCount
         })) as any;
       }

      // Format for chart
      const historyData = dailyStats.map((stat: any) => ({
        date: stat.date.toISOString().split('T')[0],
        averageGasPrice: stat.averageGasPrice.toString(),
        totalGasUsed: stat.totalGasUsed.toString(),
        transactionCount: stat.transactionCount,
        gasPerTransaction: stat.transactionCount > 0 
          ? (stat.totalGasUsed / BigInt(stat.transactionCount)).toString()
          : '0'
      }));

      // Calculate trend analysis
      const prices = dailyStats.map((stat: any) => Number(stat.averageGasPrice));
      const avgPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
      const trend = prices.length > 1 
        ? ((prices[prices.length - 1] - prices[0]) / prices[0] * 100)
        : 0;

      successResponse(res, prepareForApiResponse({
        data: historyData,
        analysis: {
          averagePrice: Math.round(avgPrice).toString(),
          trend: {
            percentage: trend.toFixed(2) + '%',
            direction: trend > 0 ? 'increasing' : trend < 0 ? 'decreasing' : 'stable'
          },
          minPrice: Math.min(...prices).toString(),
          maxPrice: Math.max(...prices).toString(),
          volatility: this.calculateVolatility(prices).toFixed(2) + '%'
        },
        period: {
          start: historyData[0]?.date || null,
          end: historyData[historyData.length - 1]?.date || null,
          days: historyData.length
        },
        dataSource: {
          type: dataSource,
          fallbackUsed: dataSource === 'real-time-computed',
          note: dataSource === 'real-time-computed' ? 'DailyStats table is empty, computed from Transaction table' : 'Using pre-aggregated DailyStats'
        }
      }), 'Gas price history retrieved successfully', 200, {
        dataPoints: historyData.length,
        granularity,
        dataSource
      });

    } catch (error) {
      throw new ApiErrorResponse(
        'Failed to retrieve gas price history',
        500,
        'GAS_HISTORY_ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Calculate price volatility (standard deviation)
   */
  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;
    
    const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const squaredDiffs = prices.map(price => Math.pow(price - mean, 2));
    const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / prices.length;
    const standardDeviation = Math.sqrt(variance);
    
    return (standardDeviation / mean) * 100; // Convert to percentage
  }
} 