#!/usr/bin/env ts-node

import dotenv from 'dotenv';
import { RestApiServer } from '../src/api/server';
import { logger } from '../src/utils/logger';

// Load environment variables
dotenv.config();

async function startRestApiServer(): Promise<void> {
  try {
    logger.info('🚀 Starting Monad Explorer REST API Server...');
    
    const apiServer = new RestApiServer();
    
    await apiServer.initialize();
    
    const port = parseInt(process.env.REST_API_PORT || '8080', 10);
    await apiServer.start(port);
    
    logger.info(`✅ REST API Server started successfully on port ${port}`);
    logger.info('📚 API Documentation available at: http://localhost:' + port + '/api');
    logger.info('🔍 Transaction endpoint example: http://localhost:' + port + '/api/transactions/{hash}');
    
  } catch (error) {
    logger.error('❌ Failed to start REST API server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

if (require.main === module) {
  startRestApiServer().catch(error => {
    logger.error('💥 Unhandled error during startup:', error);
    process.exit(1);
  });
} 