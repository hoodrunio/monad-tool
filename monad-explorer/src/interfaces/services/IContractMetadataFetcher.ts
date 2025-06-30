export interface ContractMetadata {
  address: string;
  contractExists: boolean;
  bytecode?: string;
  deploymentBytecode?: string;
  runtimeBytecode?: string;
  // ABI information
  abi?: any[];
  isProxied?: boolean;
  implementationAddress?: string;
  // Token interface detection
  isToken?: boolean;
  tokenType?: 'ERC20' | 'ERC721' | 'ERC1155' | 'UNKNOWN';
  // Verification status
  isVerified?: boolean;
  sourceName?: string;
  compilerVersion?: string;
  optimizationUsed?: boolean;
  runs?: number;
  // Contract classification
  contractType?: 'Token' | 'DEX' | 'Bridge' | 'Governance' | 'Proxy' | 'Unknown';
  // Deployment info
  creator?: string;
  creationCode?: string;
  constructorArgs?: string;
}

export interface ContractAnalysisOptions {
  blockNumber?: number;
  fetchBytecode?: boolean;
  detectTokenInterface?: boolean;
  analyzeProxy?: boolean;
  timeout?: number;
}

export interface ContractAnalysisResult {
  metadata: ContractMetadata;
  analysis: {
    codeSize: number;
    hasReceiveFunction: boolean;
    hasFallbackFunction: boolean;
    detectedInterfaces: string[];
    detectedFunctions: string[];
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    riskFactors: string[];
  };
  errors: string[];
}

export interface IContractMetadataFetcher {
  /**
   * Fetch comprehensive contract metadata
   */
  fetchMetadata(
    address: string,
    options?: ContractAnalysisOptions
  ): Promise<ContractMetadata>;

  /**
   * Perform detailed contract analysis
   */
  analyzeContract(
    address: string,
    options?: ContractAnalysisOptions
  ): Promise<ContractAnalysisResult>;

  /**
   * Check if contract exists at address
   */
  contractExists(address: string, blockNumber?: number): Promise<boolean>;

  /**
   * Get contract bytecode
   */
  getBytecode(address: string, blockNumber?: number): Promise<string | null>;

  /**
   * Detect if contract implements token interfaces
   */
  detectTokenInterface(address: string, blockNumber?: number): Promise<{
    isToken: boolean;
    tokenType?: 'ERC20' | 'ERC721' | 'ERC1155';
    supportedInterfaces: string[];
    confidence: number;
  }>;

  /**
   * Analyze proxy pattern
   */
  analyzeProxy(address: string, blockNumber?: number): Promise<{
    isProxy: boolean;
    proxyType?: 'EIP-1967' | 'EIP-1822' | 'Custom';
    implementationAddress?: string;
    adminAddress?: string;
  }>;

  /**
   * Get contract verification status from external sources
   */
  getVerificationStatus(address: string): Promise<{
    isVerified: boolean;
    source?: string;
    verifier?: 'Etherscan' | 'Sourcify' | 'Custom';
    abi?: any[];
    sourceName?: string;
    compilerVersion?: string;
  }>;

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    cacheSize: number;
    hitRate: number;
    missCount: number;
    errorCount: number;
  };

  /**
   * Clear metadata cache
   */
  clearCache(): void;
} 