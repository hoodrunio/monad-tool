import { Router, Request, Response } from 'express';
import { ServiceContainer } from '../../services/core/ServiceContainer';
import { StoreAdapter } from '../adapters/StoreAdapter';
import { IContractMetadataFetcher } from '../../interfaces/services/IContractMetadataFetcher';
import { IContractDiscoveryService } from '../../interfaces/services/IContractDiscoveryService';
import { IQueueService } from '../../interfaces/services/IQueueService';
import { asyncHandler, ApiErrorResponse, successResponse } from '../middleware/errorHandlers';
import { validateAddress, validatePaginationParams } from '../validators/common';
import { prepareForApiResponse } from '../../utils/bigint-serializer';
import { Contract } from '../../model';
import { logger } from '../../utils/logger';

/**
 * Create contract routes for contract discovery, metadata, and management
 */
export function createContractRoutes(serviceContainer: ServiceContainer): Router {
  const router = Router();

  /**
   * GET /contracts/:address
   * Get comprehensive contract information including metadata and enrichment status
   */
  router.get('/:address', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { 
      includeMetadata = 'true',
      includeBytecode = 'false',
      blockNumber
    } = req.query;

    // Validate contract address
    if (!validateAddress(address)) {
      throw new ApiErrorResponse(
        'Invalid contract address format',
        400,
        'INVALID_CONTRACT_ADDRESS'
      );
    }

    const normalizedAddress = address.toLowerCase();
    const store = await serviceContainer.resolve<StoreAdapter>('store');

    // Get contract from database
    let contract = await store.Contract.findOne({
      where: { address: normalizedAddress },
      relations: ['creationTransaction', 'creationTransaction.block']
    });

    // If contract doesn't exist in DB, check if it's a contract on-chain and create basic entity
    if (!contract) {
      const contractDiscoveryService = await serviceContainer.resolve<IContractDiscoveryService>('contractDiscoveryService');
      const isContract = await contractDiscoveryService.isContract(
        normalizedAddress, 
        blockNumber ? parseInt(blockNumber as string) : undefined
      );

      if (!isContract) {
        throw new ApiErrorResponse(
          'Address is not a contract',
          404,
          'NOT_A_CONTRACT'
        );
      }

      // Create and save basic contract entity on-demand
      const basicContracts = await contractDiscoveryService.createBasicContracts([{
        address: normalizedAddress,
        discoveredIn: 'api',
        blockNumber: blockNumber ? parseInt(blockNumber as string) : 0,
        transactionHash: 'unknown',
        creator: undefined
      }]);

      if (basicContracts.length > 0) {
        contract = basicContracts[0];
        
        // Save to database
        try {
          await store.Contract.save(contract);
          logger.debug('Contract created on-demand via API', { address: normalizedAddress });
        } catch (error) {
          logger.warn('Failed to save on-demand contract', { 
            address: normalizedAddress,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    }

    if (!contract) {
      throw new ApiErrorResponse(
        'Contract not found and could not be created',
        404,
        'CONTRACT_NOT_FOUND'
      );
    }

    // Prepare response data
    const responseData: any = {
      address: contract.address,
      creator: contract.creator,
      owner: contract.owner,
      createdAt: contract.createdAt,
      isVerified: contract.isVerified,
      name: contract.name,
      compilerVersion: contract.compilerVersion,
      creationTransaction: contract.creationTransaction ? {
        hash: contract.creationTransaction.hash,
        blockNumber: contract.creationTransaction.block?.number,
        blockHash: contract.creationTransaction.block?.hash,
        timestamp: contract.creationTransaction.timestamp
      } : null
    };

    // Include bytecode if requested
    if (includeBytecode === 'true') {
      responseData.bytecode = contract.bytecode;
      responseData.sourceCode = contract.sourceCode;
    }

    // Include metadata if requested
    if (includeMetadata === 'true') {
      try {
        const contractMetadataFetcher = await serviceContainer.resolve<IContractMetadataFetcher>('contractMetadataFetcher');
        const metadata = await contractMetadataFetcher.fetchMetadata(
          normalizedAddress,
          { 
            blockNumber: blockNumber ? parseInt(blockNumber as string) : undefined,
            fetchBytecode: includeBytecode === 'true',
            detectTokenInterface: true,
            analyzeProxy: true
          }
        );
        
        responseData.metadata = metadata;
      } catch (error) {
        responseData.metadata = {
          error: 'Metadata fetch failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }

    successResponse(res, prepareForApiResponse(responseData), 'Contract information retrieved successfully', 200, {
      metadataIncluded: includeMetadata === 'true',
      bytecodeIncluded: includeBytecode === 'true',
      onDemandCreated: !contract.creationTransaction
    });
  }));

  /**
   * GET /contracts/:address/metadata
   * Get contract metadata only (bytecode analysis, interface detection, etc.)
   */
  router.get('/:address/metadata', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { blockNumber, includeAnalysis = 'true' } = req.query;

    // Validate contract address
    if (!validateAddress(address)) {
      throw new ApiErrorResponse(
        'Invalid contract address format',
        400,
        'INVALID_CONTRACT_ADDRESS'
      );
    }

    const normalizedAddress = address.toLowerCase();

    // Check if it's a contract
    const contractDiscoveryService = await serviceContainer.resolve<IContractDiscoveryService>('contractDiscoveryService');
    const isContract = await contractDiscoveryService.isContract(
      normalizedAddress, 
      blockNumber ? parseInt(blockNumber as string) : undefined
    );

    if (!isContract) {
      throw new ApiErrorResponse(
        'Address is not a contract',
        404,
        'NOT_A_CONTRACT'
      );
    }

    // Get metadata
    const contractMetadataFetcher = await serviceContainer.resolve<IContractMetadataFetcher>('contractMetadataFetcher');
    const metadata = await contractMetadataFetcher.fetchMetadata(
      normalizedAddress,
      { 
        blockNumber: blockNumber ? parseInt(blockNumber as string) : undefined,
        fetchBytecode: includeAnalysis === 'true',
        detectTokenInterface: true,
        analyzeProxy: true
      }
    );

    successResponse(res, prepareForApiResponse({
      address: normalizedAddress,
      metadata
    }), 'Contract metadata retrieved successfully', 200, {
      blockNumber: blockNumber ? parseInt(blockNumber as string) : 'latest',
      analysisIncluded: includeAnalysis === 'true'
    });
  }));

  /**
   * GET /contracts
   * Get top 100 contracts with optional filtering
   */
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const { 
      isVerified, 
      hasSourceCode,
      createdAfter,
      createdBefore,
      creator,
      orderBy = 'createdAt',
      orderDirection = 'desc'
    } = req.query;

    const store = await serviceContainer.resolve<StoreAdapter>('store');

    // Build query conditions
    const where: any = {};
    
    if (isVerified !== undefined) {
      where.isVerified = isVerified === 'true';
    }
    
    if (hasSourceCode === 'true') {
      where.sourceCode = { not: null };
    } else if (hasSourceCode === 'false') {
      where.sourceCode = null;
    }
    
    if (creator) {
      if (!validateAddress(creator as string)) {
        throw new ApiErrorResponse(
          'Invalid creator address format',
          400,
          'INVALID_CREATOR_ADDRESS'
        );
      }
      where.creator = (creator as string).toLowerCase();
    }

    if (createdAfter) {
      where.createdAt = { ...where.createdAt, gte: new Date(createdAfter as string) };
    }
    
    if (createdBefore) {
      where.createdAt = { ...where.createdAt, lte: new Date(createdBefore as string) };
    }

    // Validate order by field
    const allowedOrderFields = ['createdAt', 'address', 'creator', 'isVerified'];
    if (!allowedOrderFields.includes(orderBy as string)) {
      throw new ApiErrorResponse(
        `Invalid orderBy field. Must be one of: ${allowedOrderFields.join(', ')}`,
        400,
        'INVALID_ORDER_FIELD'
      );
    }

    // Get top 100 contracts
    const [contracts, total] = await store.Contract.findAndCount({
      where,
      relations: ['creationTransaction', 'creationTransaction.block'],
      order: { [orderBy as string]: orderDirection === 'desc' ? 'DESC' : 'ASC' },
      take: 100
    });

    // Transform contracts for API response
    const contractsData = contracts.map((contract: Contract) => ({
      address: contract.address,
      creator: contract.creator,
      owner: contract.owner,
      createdAt: contract.createdAt,
      isVerified: contract.isVerified,
      name: contract.name,
      creationTransaction: contract.creationTransaction ? {
        hash: contract.creationTransaction.hash,
        blockNumber: contract.creationTransaction.block?.number,
        timestamp: contract.creationTransaction.timestamp
      } : null
    }));

    successResponse(res, prepareForApiResponse({
      contracts: contractsData,
      total,
      returned: contracts.length
    }), 'Top 100 contracts retrieved successfully', 200, {
      totalContracts: total,
      returned: contracts.length,
      limit: 100,
      filters: { isVerified, hasSourceCode, creator, createdAfter, createdBefore },
      ordering: { orderBy, orderDirection }
    });
  }));

  /**
   * GET /contracts/stats
   * Get contract statistics
   */
  router.get('/stats', asyncHandler(async (req: Request, res: Response) => {
    const store = await serviceContainer.resolve<StoreAdapter>('store');

    try {
      // Get basic contract counts
      const [
        totalContracts,
        verifiedContracts,
        contractsWithSourceCode,
        contractsCreatedToday
      ] = await Promise.all([
        store.Contract.count(),
        store.Contract.count({ where: { isVerified: true } }),
        store.Contract.count({ where: { sourceCode: { not: null } } }),
        store.Contract.count({
          where: {
            createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) }
          }
        })
      ]);

      // Get contract discovery cache stats
      const contractDiscoveryService = await serviceContainer.resolve<IContractDiscoveryService>('contractDiscoveryService');
      const cacheStats = contractDiscoveryService.getCacheStats();

      successResponse(res, prepareForApiResponse({
        total: totalContracts,
        verified: verifiedContracts,
        withSourceCode: contractsWithSourceCode,
        createdToday: contractsCreatedToday,
        verificationRate: totalContracts > 0 ? (verifiedContracts / totalContracts * 100).toFixed(2) + '%' : '0%',
        sourceCodeRate: totalContracts > 0 ? (contractsWithSourceCode / totalContracts * 100).toFixed(2) + '%' : '0%',
        discovery: {
          cacheSize: cacheStats.memoryCacheSize,
          hitRate: cacheStats.hitRate
        }
      }), 'Contract statistics retrieved successfully', 200, {
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      throw new ApiErrorResponse(
        'Failed to retrieve contract statistics',
        500,
        'STATS_RETRIEVAL_ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }));

  /**
   * POST /contracts/:address/enrich
   * Manually trigger contract enrichment
   */
  router.post('/:address/enrich', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const { priority = 1, forceRefresh = false } = req.body;

    // Validate contract address
    if (!validateAddress(address)) {
      throw new ApiErrorResponse(
        'Invalid contract address format',
        400,
        'INVALID_CONTRACT_ADDRESS'
      );
    }

    const normalizedAddress = address.toLowerCase();

    // Check if it's a contract
    const contractDiscoveryService = await serviceContainer.resolve<IContractDiscoveryService>('contractDiscoveryService');
    const isContract = await contractDiscoveryService.isContract(normalizedAddress);

    if (!isContract) {
      throw new ApiErrorResponse(
        'Address is not a contract',
        404,
        'NOT_A_CONTRACT'
      );
    }

    // Get or create contract entity
    const store = await serviceContainer.resolve<StoreAdapter>('store');
    let contract = await store.Contract.findOne({
      where: { address: normalizedAddress }
    });

    if (!contract) {
      // Create basic contract entity
      const basicContracts = await contractDiscoveryService.createBasicContracts([{
        address: normalizedAddress,
        discoveredIn: 'api',
        blockNumber: 0,
        transactionHash: 'manual_enrichment',
        creator: undefined
      }]);

      if (basicContracts.length > 0) {
        contract = await store.Contract.save(basicContracts[0]);
      }
    }

    if (!contract) {
      throw new ApiErrorResponse(
        'Failed to create contract entity',
        500,
        'CONTRACT_CREATION_ERROR'
      );
    }

    // Queue for enrichment
    try {
      const queueService = await serviceContainer.resolve<IQueueService>('queueService');
      
      if (!queueService.isConnected()) {
        throw new ApiErrorResponse(
          'Queue service not available',
          503,
          'QUEUE_SERVICE_UNAVAILABLE'
        );
      }

      const enrichmentMessage = {
        contractAddress: normalizedAddress,
        creator: contract.creator ?? null,
        blockNumber: 0, // Use 0 for manually triggered enrichment
        transactionHash: 'manual_enrichment',
        deploymentBytecode: undefined
      };

      await queueService.publishContractEnrichment(enrichmentMessage, {
        priority: Math.max(1, Math.min(10, priority)), // Clamp priority between 1-10
        persistent: true,
      });

      successResponse(res, prepareForApiResponse({
        address: normalizedAddress,
        enrichmentQueued: true,
        priority,
        estimatedProcessingTime: '1-5 minutes'
      }), 'Contract enrichment queued successfully', 202, {
        manualTrigger: true,
        forceRefresh
      });

    } catch (error) {
      throw new ApiErrorResponse(
        'Failed to queue contract enrichment',
        500,
        'ENRICHMENT_QUEUE_ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }));

  /**
   * GET /contracts/:address/discovery-info
   * Get contract discovery information and cache status
   */
  router.get('/:address/discovery-info', asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    // Validate contract address
    if (!validateAddress(address)) {
      throw new ApiErrorResponse(
        'Invalid contract address format',
        400,
        'INVALID_CONTRACT_ADDRESS'
      );
    }

    const normalizedAddress = address.toLowerCase();
    const contractDiscoveryService = await serviceContainer.resolve<IContractDiscoveryService>('contractDiscoveryService');
    const store = await serviceContainer.resolve<StoreAdapter>('store');

    // Check contract existence in various places
    const [isContractOnChain, contractInDb] = await Promise.all([
      contractDiscoveryService.isContract(normalizedAddress),
      store.Contract.findOne({ where: { address: normalizedAddress } })
    ]);

    successResponse(res, prepareForApiResponse({
      address: normalizedAddress,
      existsOnChain: isContractOnChain,
      existsInDatabase: !!contractInDb,
      discoveryStatus: {
        discovered: !!contractInDb,
        indexed: !!contractInDb?.creationTransaction,
        enriched: !!contractInDb?.bytecode
      }
    }), 'Contract discovery information retrieved successfully', 200, {
      onChain: isContractOnChain,
      inDatabase: !!contractInDb
    });
  }));

  return router;
} 