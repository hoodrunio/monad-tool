/**
 * Domain Extractor Service
 * 
 * Extracts validator names from DNS hostnames using:
 * 1. Custom domain mappings (for specific validator requests)
 * 2. Default pattern: xxx.domain_name.tld → domain_name 
 */

export class DomainExtractor {
  
  // Custom domain mappings for validators who request specific names
  private static customDomainMappings: Map<string, string> = new Map([
    ['monad-testnet.blockcat.tech', 'Meria'],
    ['monad.testnet.nodes.guru', 'Nodes.Guru'],
    ['testnet.monad.hoodrun.io', 'HoodRun'],
    ['monad-testnet.rpc101.org', 'Node101'],
    ['monad.testnet.pacific-meta.co.jp', 'Pacific Meta'],
    ['monad.testnet.0xmakase.co.jp', '0xmakase'],
    // Add more custom mappings here as validators request them
  ]);

  /**
   * Extract validator name from hostname
   * First checks custom mappings, then falls back to domain extraction
   */
  extractValidatorName(hostname: string): string {
    const cleanHostname = hostname.toLowerCase().trim();
    
    // Remove port for mapping check, but also check with port
    const hostnameWithoutPort = cleanHostname.split(':')[0];
    
    // Check custom mappings first (with and without port)
    if (DomainExtractor.customDomainMappings.has(cleanHostname)) {
      return DomainExtractor.customDomainMappings.get(cleanHostname)!;
    }
    
    if (DomainExtractor.customDomainMappings.has(hostnameWithoutPort)) {
      return DomainExtractor.customDomainMappings.get(hostnameWithoutPort)!;
    }
    
    // Fall back to default domain extraction
    return this.extractFromDomain(hostnameWithoutPort);
  }
  
  /**
   * Default domain extraction logic
   * Takes the domain name (second-to-last part before TLD)
   */
  private extractFromDomain(hostname: string): string {
    const parts = hostname.split('.');
    
    if (parts.length < 2) {
      return 'unknown';
    }
    
    // Take the second-to-last part (domain_name before TLD)
    const domainName = parts[parts.length - 2];
    
    // Capitalize first letter
    return domainName.charAt(0).toUpperCase() + domainName.slice(1);
  }
  
  /**
   * Add a custom domain mapping
   * @param hostname - The hostname (with or without port)
   * @param validatorName - The custom validator name
   */
  static addCustomMapping(hostname: string, validatorName: string): void {
    const cleanHostname = hostname.toLowerCase().trim();
    DomainExtractor.customDomainMappings.set(cleanHostname, validatorName);
  }
  
  /**
   * Remove a custom domain mapping
   * @param hostname - The hostname to remove
   */
  static removeCustomMapping(hostname: string): boolean {
    const cleanHostname = hostname.toLowerCase().trim();
    return DomainExtractor.customDomainMappings.delete(cleanHostname);
  }
  
  /**
   * Get all custom mappings
   */
  static getCustomMappings(): Map<string, string> {
    return new Map(DomainExtractor.customDomainMappings);
  }
  
  /**
   * Check if a hostname has a custom mapping
   */
  static hasCustomMapping(hostname: string): boolean {
    const cleanHostname = hostname.toLowerCase().trim();
    const hostnameWithoutPort = cleanHostname.split(':')[0];
    
    return DomainExtractor.customDomainMappings.has(cleanHostname) || 
           DomainExtractor.customDomainMappings.has(hostnameWithoutPort);
  }
  
  /**
   * Extract validator names from multiple hostnames
   */
  extractValidatorNames(hostnames: string[]): Map<string, string> {
    const results = new Map<string, string>();
    
    for (const hostname of hostnames) {
      const validatorName = this.extractValidatorName(hostname);
      results.set(hostname, validatorName);
    }
    
    return results;
  }
} 