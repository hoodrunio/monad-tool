import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

export interface ApiErrorResponse extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
}

/**
 * Custom error class for API errors
 */
export class ApiErrorResponse extends Error {
  public statusCode: number;
  public code: string;
  public details?: unknown;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    details?: unknown
  ) {
    super(message);
    this.name = 'ApiErrorResponse';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Not found handler - should be used before error handler
 */
export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  const error = new ApiErrorResponse(
    `Route not found: ${req.method} ${req.path}`,
    404,
    'ROUTE_NOT_FOUND',
    {
      method: req.method,
      path: req.path,
      availableRoutes: [
        'GET /health',
        'GET /api',
        'GET /api/transactions/:hash',
        'GET /api/transactions/:hash/token-transfers',
        'GET /api/addresses/:address/transactions',
        'GET /api/addresses/:address/token-transfers',
        'GET /api/blocks/:number/transactions'
      ]
    }
  );

  next(error);
}

/**
 * Main error handler - should be last middleware
 */
export function errorHandler(
  error: ApiErrorResponse,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If response already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(error);
  }

  // Default error properties
  let statusCode = error.statusCode || 500;
  let code = error.code || 'INTERNAL_ERROR';
  let message = error.message || 'An unexpected error occurred';
  let details = error.details;

  // Handle specific error types
  if (error.name === 'ValidationError') {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
  } else if (error.name === 'CastError') {
    statusCode = 400;
    code = 'INVALID_ID';
    message = 'Invalid ID format';
  } else if (error.name === 'QueryFailedError') {
    statusCode = 400;
    code = 'DATABASE_QUERY_ERROR';
    message = 'Database query failed';
  } else if (error.message?.includes('not found')) {
    statusCode = 404;
    code = 'NOT_FOUND';
  } else if (error.message?.includes('timeout')) {
    statusCode = 408;
    code = 'REQUEST_TIMEOUT';
  }

  // Log error (but not 4xx client errors)
  if (statusCode >= 500) {
    logger.error('API Error', {
      error: message,
      statusCode,
      code,
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      stack: error.stack,
      details,
    });
  } else {
    logger.warn('API Client Error', {
      error: message,
      statusCode,
      code,
      method: req.method,
      url: req.url,
      ip: req.ip,
    });
  }

  // Send error response
  const responseBody: any = {
    success: false,
    error: {
      code,
      message,
      statusCode,
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: req.get('X-Request-ID') || 'unknown',
      method: req.method,
      path: req.path,
    },
  };

  // Include details in development
  if (process.env.NODE_ENV === 'development' && details) {
    responseBody.error.details = details;
  }

  // Include stack trace in development for 5xx errors
  if (process.env.NODE_ENV === 'development' && statusCode >= 500) {
    responseBody.error.stack = error.stack;
  }

  res.status(statusCode).json(responseBody);
}

/**
 * Async error wrapper - wraps async route handlers to catch errors
 */
export function asyncHandler<T extends Request, U extends Response>(
  fn: (req: T, res: U, next: NextFunction) => Promise<void>
): (req: T, res: U, next: NextFunction) => void {
  return (req: T, res: U, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Create standardized success response
 */
export function successResponse<T>(
  res: Response,
  data: T,
  message: string = 'Success',
  statusCode: number = 200,
  meta?: Record<string, unknown>
): void {
  res.status(statusCode).json({
    success: true,
    message,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...(meta || {}),
    },
  });
}

/**
 * Create paginated response
 */
export function paginatedResponse<T>(
  res: Response,
  data: T[],
  total: number,
  page: number,
  limit: number,
  message: string = 'Success'
): void {
  const totalPages = Math.ceil(total / limit);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  res.json({
    success: true,
    message,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasNext,
      hasPrev,
    },
    meta: {
      timestamp: new Date().toISOString(),
    },
  });
} 