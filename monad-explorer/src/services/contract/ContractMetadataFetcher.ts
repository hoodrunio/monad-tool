import { 
  IContractMetadataFetcher, 
  ContractMetadata, 
  ContractAnalysisOptions, 
  ContractAnalysisResult 
} from '../../interfaces/services/IContractMetadataFetcher';
import { IRpcClient } from '../../interfaces/blockchain/IRpcClient';
import { ITokenDetectionService } from '../../interfaces/services/ITokenDetectionService';
import { ICacheService } from '../../interfaces/cache/ICacheService';
import { logger } from '../../utils/logger';

/**
 * Contract metadata fetcher with comprehensive analysis capabilities
 * Fetches bytecode, analyzes interfaces, detects proxies, and classifies contracts
 */
export class ContractMetadataFetcher implements IContractMetadataFetcher {
  private readonly cachePrefix = 'contract_metadata:';
  private readonly cacheTtl = 86400; // 24 hour cache (contract metadata is mostly immutable)
  
  // Cache statistics
  private cacheStats = {
    cacheSize: 0,
    hitCount: 0,
    missCount: 0,
    errorCount: 0,
  };

  // Known interface signatures for detection
  private readonly interfaceSignatures = {
    ERC165: '0x01ffc9a7',
    ERC20: '0x36372b07',
    ERC721: '0x80ac58cd',
    ERC721Metadata: '0x5b5e139f',
    ERC721Enumerable: '0x780e9d63',
    ERC1155: '0xd9b67a26',
    ERC1155MetadataURI: '0x0e89341c',
    // Proxy interfaces
    EIP1967Proxy: '0x360894a1', // implementation slot
    EIP1822Proxy: '0xc5f16f0f', // proxiable UUID
  };

  constructor(
    private readonly rpcClient: IRpcClient,
    private readonly tokenDetectionService: ITokenDetectionService,
    private readonly cacheService: ICacheService
  ) {}

  public async fetchMetadata(
    address: string,
    options: ContractAnalysisOptions = {}
  ): Promise<ContractMetadata> {
    const cacheKey = `${this.cachePrefix}${address.toLowerCase()}`;
    
    try {
      // Check cache first
      const cached = await this.cacheService.get<ContractMetadata>(cacheKey);
      if (cached) {
        this.cacheStats.hitCount++;
        logger.debug('Contract metadata cache hit', { address });
        return cached;
      }
      
      this.cacheStats.missCount++;
      logger.debug('Contract metadata cache miss, fetching', { address });

      // Check if contract exists (unless skipped for performance)
      let contractExists = true; // Assume true if skipping check
      if (!options.skipContractCheck) {
        contractExists = await this.contractExists(address, options.blockNumber);
        if (!contractExists) {
          const metadata: ContractMetadata = {
            address: address.toLowerCase(),
            contractExists: false,
          };
          
          await this.cacheService.set(cacheKey, metadata, this.cacheTtl);
          return metadata;
        }
      }

      // Fetch basic metadata
      const metadata: ContractMetadata = {
        address: address.toLowerCase(),
        contractExists: true,
      };

                   // Fetch bytecode if explicitly requested
      if (options.fetchBytecode === true) {
        const bytecode = await this.getBytecode(address, options.blockNumber);
        metadata.runtimeBytecode = bytecode || undefined;
        if (metadata.runtimeBytecode) {
          metadata.bytecode = metadata.runtimeBytecode; // Alias for compatibility
        }
      }

      // Detect token interface if requested
      if (options.detectTokenInterface !== false) {
        try {
          const tokenDetection = await this.detectTokenInterface(address, options.blockNumber);
          metadata.isToken = tokenDetection.isToken;
          metadata.tokenType = tokenDetection.tokenType;
        } catch (error) {
          logger.debug('Token interface detection failed', { 
            address, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      }

      // Analyze proxy pattern if requested
      if (options.analyzeProxy !== false) {
        try {
          const proxyAnalysis = await this.analyzeProxy(address, options.blockNumber);
          metadata.isProxied = proxyAnalysis.isProxy;
          metadata.implementationAddress = proxyAnalysis.implementationAddress;
        } catch (error) {
          logger.debug('Proxy analysis failed', { 
            address, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      }

      // Classify contract type
      metadata.contractType = this.classifyContract(metadata);

      // Cache the result
      await this.cacheService.set(cacheKey, metadata, this.cacheTtl);
      this.cacheStats.cacheSize++;

      logger.debug('Contract metadata fetched successfully', {
        address,
        contractExists: metadata.contractExists,
        isToken: metadata.isToken,
        tokenType: metadata.tokenType,
        isProxied: metadata.isProxied,
        contractType: metadata.contractType,
      });

      return metadata;

    } catch (error) {
      this.cacheStats.errorCount++;
      logger.error('Failed to fetch contract metadata', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  public async analyzeContract(
    address: string,
    options: ContractAnalysisOptions = {}
  ): Promise<ContractAnalysisResult> {
    const metadata = await this.fetchMetadata(address, options);
    
    const analysis = {
       codeSize: 0,
       hasReceiveFunction: false,
       hasFallbackFunction: false,
       detectedInterfaces: [] as string[],
       detectedFunctions: [] as string[],
       riskLevel: 'LOW' as 'LOW' | 'MEDIUM' | 'HIGH',
       riskFactors: [] as string[],
     };

    const errors: string[] = [];

    if (metadata.contractExists && metadata.runtimeBytecode) {
      try {
        // Analyze bytecode
        analysis.codeSize = (metadata.runtimeBytecode.length - 2) / 2; // Remove 0x and convert to bytes
        
        // Basic function detection (simplified)
        analysis.hasReceiveFunction = metadata.runtimeBytecode.includes('receive()');
        analysis.hasFallbackFunction = metadata.runtimeBytecode.includes('fallback()');
        
        // Interface detection
        for (const [interfaceName, signature] of Object.entries(this.interfaceSignatures)) {
          if (metadata.runtimeBytecode.includes(signature.slice(2))) {
            analysis.detectedInterfaces.push(interfaceName);
          }
        }

        // Risk assessment
        const riskFactors = [];
        if (analysis.codeSize > 24576) { // Max contract size
          riskFactors.push('Large contract size');
        }
        if (metadata.isProxied && !metadata.implementationAddress) {
          riskFactors.push('Unverified proxy implementation');
        }
        if (!metadata.isVerified) {
          riskFactors.push('Unverified contract');
        }

        analysis.riskFactors = riskFactors;
        analysis.riskLevel = riskFactors.length > 2 ? 'HIGH' : riskFactors.length > 0 ? 'MEDIUM' : 'LOW';

      } catch (error) {
        errors.push(`Bytecode analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return {
      metadata,
      analysis,
      errors,
    };
  }

  public async contractExists(address: string, blockNumber?: number): Promise<boolean> {
    try {
      const code = await this.rpcClient.getCode(address, blockNumber || 'latest');
      return Boolean(code && code !== '0x' && code.length > 2);
    } catch (error) {
      logger.debug('Contract existence check failed', {
        address,
        blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  public async getBytecode(address: string, blockNumber?: number): Promise<string | null> {
    try {
      const code = await this.rpcClient.getCode(address, blockNumber || 'latest');
      return code && code !== '0x' ? code : null;
    } catch (error) {
      logger.debug('Bytecode fetch failed', {
        address,
        blockNumber,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  public async detectTokenInterface(address: string, blockNumber?: number): Promise<{
    isToken: boolean;
    tokenType?: 'ERC20' | 'ERC721' | 'ERC1155';
    supportedInterfaces: string[];
    confidence: number;
  }> {
    try {
      // Use existing token detection service
      const detection = await this.tokenDetectionService.detectTokenType(address, { blockNumber });
      
      const supportedInterfaces: string[] = [];
      let tokenType: 'ERC20' | 'ERC721' | 'ERC1155' | undefined;

      if (detection.isERC20) {
        supportedInterfaces.push('ERC20');
        tokenType = 'ERC20';
      }
      if (detection.isERC721) {
        supportedInterfaces.push('ERC721');
        tokenType = 'ERC721';
      }
      if (detection.isERC1155) {
        supportedInterfaces.push('ERC1155');
        tokenType = 'ERC1155';
      }

      return {
        isToken: detection.detectedType !== null,
        tokenType,
        supportedInterfaces,
        confidence: detection.confidence,
      };

    } catch (error) {
      logger.debug('Token interface detection failed', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      
      return {
        isToken: false,
        supportedInterfaces: [],
        confidence: 0,
      };
    }
  }

  public async analyzeProxy(address: string, blockNumber?: number): Promise<{
    isProxy: boolean;
    proxyType?: 'EIP-1967' | 'EIP-1822' | 'Custom';
    implementationAddress?: string;
    adminAddress?: string;
  }> {
    try {
             // Check for EIP-1967 proxy (most common)
       const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
       const implAddress = await this.rpcClient.call('eth_getStorageAt', [address, implSlot, blockNumber || 'latest']) as string;
       
       if (implAddress && implAddress !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
         // Extract address from storage slot (last 20 bytes)
         const implementationAddress = '0x' + implAddress.slice(-40);
         
         return {
           isProxy: true,
           proxyType: 'EIP-1967',
           implementationAddress,
         };
       }

       // Check for EIP-1822 proxy
       const proxiableSlot = '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7';
       const proxiableAddress = await this.rpcClient.call('eth_getStorageAt', [address, proxiableSlot, blockNumber || 'latest']) as string;
       
       if (proxiableAddress && proxiableAddress !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
         return {
           isProxy: true,
           proxyType: 'EIP-1822',
           implementationAddress: '0x' + proxiableAddress.slice(-40),
         };
       }

      return {
        isProxy: false,
      };

    } catch (error) {
      logger.debug('Proxy analysis failed', {
        address,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      
      return {
        isProxy: false,
      };
    }
  }

  public async getVerificationStatus(address: string): Promise<{
    isVerified: boolean;
    source?: string;
    verifier?: 'Etherscan' | 'Sourcify' | 'Custom';
    abi?: any[];
    sourceName?: string;
    compilerVersion?: string;
  }> {
    // This would typically fetch from verification services
    // For now, return unverified status
    logger.debug('Verification status check not implemented', { address });
    
    return {
      isVerified: false,
    };
  }

  public getCacheStats() {
    const totalRequests = this.cacheStats.hitCount + this.cacheStats.missCount;
    const hitRate = totalRequests > 0 ? this.cacheStats.hitCount / totalRequests : 0;
    
    return {
      cacheSize: this.cacheStats.cacheSize,
      hitRate,
      missCount: this.cacheStats.missCount,
      errorCount: this.cacheStats.errorCount,
    };
  }

  public clearCache(): void {
    // This would clear the cache if we had direct access
    // For now, just reset stats
    this.cacheStats = {
      cacheSize: 0,
      hitCount: 0,
      missCount: 0,
      errorCount: 0,
    };
  }

  /**
   * Classify contract based on metadata
   */
  private classifyContract(metadata: ContractMetadata): 'Token' | 'DEX' | 'Bridge' | 'Governance' | 'Proxy' | 'Unknown' {
    if (metadata.isToken) {
      return 'Token';
    }
    
    if (metadata.isProxied) {
      return 'Proxy';
    }

    // Additional classification logic could be added here
    // based on bytecode analysis, function signatures, etc.
    
    return 'Unknown';
  }
} 