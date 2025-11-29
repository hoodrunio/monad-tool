import * as net from 'net';
import { logger } from '../../utils/logger.js';

interface PeerInfo {
  pubkey: string;
  addr: string;
  signature: string;
  record_seq_num: number;
}

interface GetPeersResponse {
  Read: {
    GetPeers: {
      Response: PeerInfo[];
    };
  };
}

interface IpcRequest {
  Read: {
    GetPeers: string;
  };
}

export class MonadIpcClient {
  private readonly socketPath: string;
  private readonly connectionTimeout: number;
  private readonly maxRetries: number;

  constructor(
    socketPath: string,
    connectionTimeout: number = 5000,
    maxRetries: number = 3
  ) {
    this.socketPath = socketPath;
    this.connectionTimeout = connectionTimeout;
    this.maxRetries = maxRetries;
  }

  async getPeers(): Promise<PeerInfo[]> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        logger.debug(
          `Attempting to get peers from IPC (attempt ${attempt}/${this.maxRetries})`
        );
        return await this.getPeersInternal();
      } catch (error) {
        lastError = error as Error;
        logger.error(
          `IPC GetPeers attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`
        );

        if (attempt < this.maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          logger.debug(`Retrying in ${backoffMs}ms...`);
          await this.sleep(backoffMs);
        }
      }
    }

    throw new Error(
      `Failed to get peers after ${this.maxRetries} attempts: ${lastError?.message}`
    );
  }

  private async getPeersInternal(): Promise<PeerInfo[]> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let responseData = Buffer.alloc(0);
      let timeoutHandle: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        socket.destroy();
      };

      timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error(`IPC connection timeout after ${this.connectionTimeout}ms`));
      }, this.connectionTimeout);

      socket.on('connect', () => {
        logger.debug(`Connected to IPC socket: ${this.socketPath}`);

        const request: IpcRequest = {
          Read: {
            GetPeers: 'Request',
          },
        };

        try {
          const requestJson = JSON.stringify(request);
          const requestBuffer = Buffer.from(requestJson, 'utf8');
          const lengthBuffer = Buffer.allocUnsafe(4);
          lengthBuffer.writeUInt32BE(requestBuffer.length, 0);

          socket.write(lengthBuffer);
          socket.write(requestBuffer);

          logger.debug(`Sent GetPeers request (${requestBuffer.length} bytes)`);
        } catch (error) {
          cleanup();
          reject(new Error(`Failed to send request: ${error instanceof Error ? error.message : String(error)}`));
        }
      });

      socket.on('data', (chunk: Buffer) => {
        responseData = Buffer.concat([responseData, chunk]);

        // Try to parse response if we have at least 4 bytes (length prefix)
        if (responseData.length >= 4) {
          const messageLength = responseData.readUInt32BE(0);
          const totalLength = 4 + messageLength;

          if (responseData.length >= totalLength) {
            cleanup();

            try {
              const messageBuffer = responseData.subarray(4, totalLength);
              const messageJson = messageBuffer.toString('utf8');
              const response: GetPeersResponse = JSON.parse(messageJson);

              if (!response.Read?.GetPeers?.Response) {
                reject(new Error('Invalid IPC response format'));
                return;
              }

              const peers = response.Read.GetPeers.Response;
              logger.info(`Successfully retrieved ${peers.length} peers from IPC`);
              resolve(peers);
            } catch (error) {
              reject(
                new Error(
                  `Failed to parse IPC response: ${error instanceof Error ? error.message : String(error)}`
                )
              );
            }
          }
        }
      });

      socket.on('error', (error: Error) => {
        cleanup();
        reject(new Error(`IPC socket error: ${error.message}`));
      });

      socket.on('close', () => {
        if (responseData.length === 0) {
          cleanup();
          reject(new Error('IPC socket closed without response'));
        }
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getPeers();
      return true;
    } catch (error) {
      logger.error(
        `IPC connection test failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }
}
