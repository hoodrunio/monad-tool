/**
 * Domain Extractor Service
 * 
 * Extracts validator names from DNS hostnames by taking the main domain name.
 * Simple approach: take the second-to-last part of the domain.
 * 
 * Examples:
 * - mf-testnet-2-val-tsw-pit-004.monadinfra.com → monadinfra
 * - bue-004.devcore4.com → devcore4
 * - monad.testnet.lux8.net → lux8
 * - monad-testnet.stakecraft.com → stakecraft
 * - monad.0xhub.xyz → 0xhub
 */

export class DomainExtractor {
  
  /**
   * Extract validator name from hostname
   * Simply takes the main domain name (second-to-last part)
   */
  extractValidatorName(hostname: string): string {
    const cleanHostname = hostname.toLowerCase().trim().split(':')[0];
    const parts = cleanHostname.split('.');
    
    if (parts.length < 2) {
      return 'unknown';
    }
    
    // Take the second-to-last part (main domain name)
    return parts[parts.length - 2];
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