// Monad Validator Analytics - API Server Startup Script
import { main } from '../src/api/main';

console.log('🚀 Starting Monad Validator Analytics API Server...');
console.log('====================================================');

// Start the API application
main().catch((error) => {
  console.error('❌ Fatal error starting API server:', error);
  process.exit(1);
}); 