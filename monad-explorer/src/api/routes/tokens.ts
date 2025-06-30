import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { ITokenDetectionService } from '../../interfaces/services/ITokenDetectionService';
import { ITokenRepository } from '../../interfaces/services/ITokenRepository';
import { ITokenMetadataFetcher } from '../../interfaces/services/ITokenMetadataFetcher';
import { ITransactionService } from '../../interfaces/services/ITransactionService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateAddress, validatePaginationParams } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { TokenType } from '../../model';

/**
 * Create token routes using the token detection and metadata services
 */
export function createTokenRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /tokens/:address
   * Get comprehensive token information including metadata and detection status
   */
  router.get('/:address', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { 
      includeMetadata = 'true',
      blockNumber
    } = req.query;

    // Validate token address
    if (!validateAddress(address)) {
      throw new ApiErrorResponse(
        'Invalid token address format',
        400,
        'INVALID_TOKEN_ADDRESS'
      );
    }

    // Get services
    const tokenRepository = await serviceContainer.resolve<ITokenRepository>('tokenRepository');
    const tokenDetectionService = await serviceContainer.resolve<ITokenDetectionService>('tokenDetectionService');
    const tokenMetadataFetcher = await serviceContainer.resolve<ITokenMetadataFetcher>('tokenMetadataFetcher');

    // Check if token exists in database
    const tokenInfo = await tokenRepository.get(address);
    
    // Prepare response data
    const responseData: any = {
      address,
      exists: !!tokenInfo,
      tokenInfo: tokenInfo || null
    };



    // Include metadata if requested and we have a detected type
    if (includeMetadata === 'true' && (tokenInfo?.type || responseData.detection?.detectedType)) {
      try {
        const tokenType = tokenInfo?.type || responseData.detection?.detectedType;
        const metadata = await tokenMetadataFetcher.fetchMetadata(
          address,
          tokenType,
          blockNumber ? parseInt(blockNumber as string) : undefined
        );
        
        responseData.metadata = metadata;
      } catch (error) {
        responseData.metadata = {
          error: 'Metadata fetch failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }

    successResponse(res, prepareForApiResponse(responseData), 'Token information retrieved successfully', 200, {
      cached: !!tokenInfo,
      metadataIncluded: includeMetadata === 'true'
    });
  }));

  /**
   * GET /tokens/:address/transfers
   * Get all token transfers for a specific token address (paginated)
   */
  router.get('/:address/transfers', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { limit, offset } = validatePaginationParams(req.query);
    const { 
      includeMetadata = 'false'
    } = req.query;

    // Validate token address
    if (!validateAddress(address)) {
      throw new ApiErrorResponse(
        'Invalid token address format',
        400,
        'INVALID_TOKEN_ADDRESS'
      );
    }

    // Get required services
    const store = await serviceContainer.resolve<StoreAdapter>('store');
    const transactionService = await serviceContainer.resolve<ITransactionService>('transactionService');

    const startTime = Date.now();
    const normalizedTokenAddress = address.toLowerCase();

    try {
      // Get transfer event signatures that we support
      const transferSignatures = [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer(address,address,uint256)
        '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', // TransferSingle(address,address,address,uint256,uint256)
        '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'  // TransferBatch(address,address,address,uint256[],uint256[])
      ];

      // First get total count of logs for this token address with transfer signatures
      const [, totalCount] = await store.Log.findAndCount({
        where: {
          address: normalizedTokenAddress
        },
        select: ['id'] // Only count, don't fetch full data
      });

      if (totalCount === 0) {
        return successResponse(res, prepareForApiResponse({
          tokenAddress: address,
          transfers: [],
          total: 0
        }), 'No transfers found for this token', 200, {
          totalTransfers: 0,
          limit,
          offset,
          hasMore: false,
          metadataIncluded: includeMetadata === 'true'
        });
      }

      // Get logs for this token address with pagination
      const logs = await store.Log.find({
        where: {
          address: normalizedTokenAddress
        },
        relations: ['transaction', 'transaction.block'],
        order: { id: 'DESC' }, // Most recent first
        skip: offset,
        take: limit
      });

      // Filter logs that are token transfer events
      const transferLogs = logs.filter((log: any) => 
        log.topics && 
        log.topics.length > 0 && 
        transferSignatures.includes(log.topics[0])
      );

      if (transferLogs.length === 0) {
        return successResponse(res, prepareForApiResponse({
          tokenAddress: address,
          transfers: [],
          total: totalCount
        }), 'No transfer logs found in this page', 200, {
          totalTransfers: totalCount,
          limit,
          offset,
          hasMore: offset + limit < totalCount,
          metadataIncluded: includeMetadata === 'true'
        });
      }

      // Parse token transfers from logs using TransactionService
      const parsedTransfers: any[] = [];
      
      for (const log of transferLogs) {
        try {
          // Parse individual transfer from log
          const transfers = await transactionService.getTokenTransfersForTransaction(
            log.transaction.hash,
            { includeMetadata: includeMetadata === 'true' }
          );
          
          // Filter transfers that match our token address and log index
          const matchingTransfers = transfers.filter(transfer => 
            transfer.tokenAddress.toLowerCase() === normalizedTokenAddress &&
            transfer.logIndex === log.logIndex
          );
          
          parsedTransfers.push(...matchingTransfers);
        } catch (error) {
          // Skip failed parsing but continue with others
          continue;
        }
      }

      const parseTime = Date.now() - startTime;

      successResponse(res, prepareForApiResponse({
        tokenAddress: address,
        transfers: parsedTransfers,
        total: totalCount,
        parseTime: `${parseTime}ms`
      }), 'Token transfers retrieved successfully', 200, {
        totalTransfers: totalCount,
        returned: parsedTransfers.length,
        limit,
        offset,
        hasMore: offset + limit < totalCount,
        metadataIncluded: includeMetadata === 'true',
        performance: 'runtime-parsed'
      });

    } catch (error) {
      throw new ApiErrorResponse(
        'Failed to retrieve token transfers',
        500,
        'TRANSFER_RETRIEVAL_ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }));

  /**
   * GET /tokens/:address/detect
   * Detect token type and supported interfaces
   */
  router.get('/:address/detect', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { blockNumber } = req.query;

    // Validate token address
    if (!validateAddress(address)) {
      throw new ApiErrorResponse(
        'Invalid token address format',
        400,
        'INVALID_TOKEN_ADDRESS'
      );
    }

    // Get token detection service
    const tokenDetectionService = await serviceContainer.resolve<ITokenDetectionService>('tokenDetectionService');

    // Detect token type
    const detectionResult = await tokenDetectionService.detectTokenType(address, {
      blockNumber: blockNumber ? parseInt(blockNumber as string) : undefined
    });

    // Check if contract exists
    const contractExists = await tokenDetectionService.contractExists(
      address,
      blockNumber ? parseInt(blockNumber as string) : undefined
    );

    successResponse(res, prepareForApiResponse({
      address,
      contractExists,
    }), 'Token detection completed successfully', 200, {
      blockNumber: blockNumber ? parseInt(blockNumber as string) : 'latest'
    });
  }));

  /**
   * GET /tokens/:address/metadata
   * Get token metadata only
   */
  router.get('/:address/metadata', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { tokenType, blockNumber, includeExtendedMetadata = 'false' } = req.query;

    // Validate token address
    if (!validateAddress(address)) {
      throw new ApiErrorResponse(
        'Invalid token address format',
        400,
        'INVALID_TOKEN_ADDRESS'
      );
    }

    // Validate token type if provided
    let detectedTokenType = tokenType as TokenType;
    if (tokenType && !Object.values(TokenType).includes(tokenType as TokenType)) {
      throw new ApiErrorResponse(
        'Invalid token type. Must be one of: ERC20, ERC721, ERC1155, UNKNOWN',
        400,
        'INVALID_TOKEN_TYPE'
      );
    }

    // If no token type provided, try to get from repository or detect
    if (!detectedTokenType) {
      const tokenRepository = await serviceContainer.resolve<ITokenRepository>('tokenRepository');
      const tokenInfo = await tokenRepository.get(address);
      
      if (tokenInfo?.type) {
        detectedTokenType = tokenInfo.type;
      } else {
        // Fallback to detection
        const tokenDetectionService = await serviceContainer.resolve<ITokenDetectionService>('tokenDetectionService');
        const detection = await tokenDetectionService.detectTokenType(address);
        detectedTokenType = detection.detectedType || TokenType.UNKNOWN;
      }
    }

    // Get metadata
    const tokenMetadataFetcher = await serviceContainer.resolve<ITokenMetadataFetcher>('tokenMetadataFetcher');
    const metadata = await tokenMetadataFetcher.fetchMetadata(
      address,
      detectedTokenType,
      blockNumber ? parseInt(blockNumber as string) : undefined
    );

    successResponse(res, prepareForApiResponse({
      address,
      tokenType: detectedTokenType,
      metadata
    }), 'Token metadata retrieved successfully', 200, {
      tokenType: detectedTokenType,
      blockNumber: blockNumber ? parseInt(blockNumber as string) : 'latest',
      extendedMetadata: includeExtendedMetadata === 'true'
    });
  }));

  /**
   * GET /tokens/stats
   * Get token detection statistics
   */
  router.get('/stats', asyncHandler(async (req: Request, res: Response) => {
    // Get token detection service
    const tokenDetectionService = await serviceContainer.resolve<ITokenDetectionService>('tokenDetectionService');

    // Get detection statistics
    const stats = tokenDetectionService.getStats();

    successResponse(res, prepareForApiResponse({
      detectionStats: stats
    }), 'Token detection statistics retrieved successfully', 200, {
      timestamp: new Date().toISOString()
    });
  }));

  return router;
} 