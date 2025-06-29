/**
 * Validate Ethereum transaction hash format
 */
export function validateTransactionHash(hash: string): boolean {
  if (!hash || typeof hash !== 'string') {
    return false;
  }
  
  // Must be 0x followed by 64 hex characters
  const hashRegex = /^0x[a-fA-F0-9]{64}$/;
  return hashRegex.test(hash);
}

/**
 * Validate Ethereum address format
 */
export function validateAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  
  // Must be 0x followed by 40 hex characters
  const addressRegex = /^0x[a-fA-F0-9]{40}$/;
  return addressRegex.test(address);
}

/**
 * Validate block number
 */
export function validateBlockNumber(blockNumber: string | number): boolean {
  if (typeof blockNumber === 'string') {
    const num = parseInt(blockNumber, 10);
    return !isNaN(num) && num >= 0;
  }
  
  if (typeof blockNumber === 'number') {
    return blockNumber >= 0 && Number.isInteger(blockNumber);
  }
  
  return false;
}

/**
 * Validate and normalize pagination parameters
 */
export function validatePaginationParams(query: any): {
  limit: number;
  offset: number;
  page: number;
} {
  let limit = 20; // default
  let offset = 0; // default
  let page = 1; // default

  // Validate limit
  if (query.limit) {
    const parsedLimit = parseInt(query.limit, 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0 && parsedLimit <= 100) {
      limit = parsedLimit;
    }
  }

  // Validate page or offset
  if (query.page) {
    const parsedPage = parseInt(query.page, 10);
    if (!isNaN(parsedPage) && parsedPage >= 1) {
      page = parsedPage;
      offset = (page - 1) * limit;
    }
  } else if (query.offset) {
    const parsedOffset = parseInt(query.offset, 10);
    if (!isNaN(parsedOffset) && parsedOffset >= 0) {
      offset = parsedOffset;
      page = Math.floor(offset / limit) + 1;
    }
  }

  return { limit, offset, page };
}

/**
 * Validate boolean query parameter
 */
export function validateBoolean(value: any, defaultValue: boolean = false): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  
  if (typeof value === 'boolean') {
    return value;
  }
  
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  
  return defaultValue;
}

/**
 * Validate sort direction
 */
export function validateSortDirection(direction: any): 'ASC' | 'DESC' {
  if (typeof direction === 'string') {
    const normalized = direction.toUpperCase();
    if (normalized === 'ASC' || normalized === 'DESC') {
      return normalized as 'ASC' | 'DESC';
    }
  }
  
  return 'DESC'; // default
} 