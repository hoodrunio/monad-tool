import axios from 'axios';
import { logger } from '../../utils';

export class NodeRpcClient {
  constructor(private readonly rpcUrl: string, private readonly timeout: number = 10000) {
    if (!rpcUrl) {
      throw new Error('RPC_URL is not configured.');
    }
  }

  /**
   * Fetches the latest block number from the RPC endpoint.
   * @returns The current block number.
   */
  async getLatestBlockNumber(): Promise<number> {
    logger.info('Fetching latest block number from RPC...');
    
    try {
      const response = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: this.timeout,
        }
      );

      if (response.data.error) {
        throw new Error(`RPC error: ${response.data.error.message}`);
      }

      const blockNumberHex = response.data.result;
      const blockNumber = parseInt(blockNumberHex, 16);

      logger.info(`Successfully fetched block number: ${blockNumber}`);
      return blockNumber;
    } catch (error) {
      logger.error('Failed to fetch latest block number from RPC.', {
        error: error instanceof Error ? error.message : String(error),
        rpcUrl: this.rpcUrl,
      });
      throw new Error('Could not fetch block number from RPC endpoint.');
    }
  }
} 