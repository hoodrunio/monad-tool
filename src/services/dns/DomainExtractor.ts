/**
 * Domain Extractor Service
 * 
 * Extracts validator names from DNS hostnames using the simple pattern:
 * xxx.domain_name.tld → domain_name 
 */

export class DomainExtractor {
  
  /**
   * Extract validator name from hostname
   * Takes the domain name (second-to-last part before TLD)
   */
  extractValidatorName(hostname: string): string {
    const cleanHostname = hostname.toLowerCase().trim().split(':')[0];
    const parts = cleanHostname.split('.');
    
    if (parts.length < 2) {
      return 'unknown';
    }
    
    // Take the second-to-last part (domain_name before TLD)
    const domainName = parts[parts.length - 2];
    
    // Capitalize first letter
    return domainName.charAt(0).toUpperCase() + domainName.slice(1);
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