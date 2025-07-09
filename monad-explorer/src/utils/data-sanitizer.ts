/**
 * Data Sanitizer Utility
 * Handles null bytes and other PostgreSQL UTF8 incompatible characters
 */

/**
 * Remove null bytes and other problematic characters from strings
 * PostgreSQL UTF8 encoding doesn't allow null bytes (0x00)
 */
export function sanitizeString(str: string | null | undefined): string | null {
  if (!str) {
    return str as null;
  }

  // Remove null bytes and other control characters that cause UTF8 issues
  return str
    .replace(/\x00/g, '') // Remove null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove other control chars except \t, \n, \r
    .trim();
}

/**
 * Sanitize string but return empty string for non-nullable database fields
 */
export function sanitizeStringRequired(str: string | null | undefined): string {
  const sanitized = sanitizeString(str);
  return sanitized || '';
}

/**
 * Sanitize transaction data before database insertion
 */
export function sanitizeTransactionData(txData: any): any {
  return {
    ...txData,
    input: sanitizeString(txData.input),
    error: sanitizeString(txData.error),
    revertReason: sanitizeString(txData.revertReason),
    methodName: sanitizeString(txData.methodName),
    methodID: sanitizeString(txData.methodID),
    inputDecoded: sanitizeString(txData.inputDecoded),
  };
}

/**
 * Sanitize log data before database insertion
 */
export function sanitizeLogData(logData: any): any {
  return {
    ...logData,
    data: sanitizeString(logData.data),
    // Topics are arrays, sanitize each element
    topics: logData.topics?.map((topic: string) => sanitizeString(topic)) || [],
  };
}

/**
 * Sanitize contract data before database insertion
 */
export function sanitizeContractData(contractData: any): any {
  return {
    ...contractData,
    bytecode: sanitizeString(contractData.bytecode),
    sourceCode: sanitizeString(contractData.sourceCode),
    name: sanitizeString(contractData.name),
    compilerVersion: sanitizeString(contractData.compilerVersion),
  };
}

/**
 * Generic object sanitizer for any data going to PostgreSQL
 */
export function sanitizeObjectStrings(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObjectStrings);
  }

  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObjectStrings(value);
    }
    return sanitized;
  }

  return obj;
}

/**
 * Sanitize entity instances in place without converting to plain objects
 * This preserves TypeORM entity prototype methods and structure
 */
export function sanitizeEntityInPlace(entity: any): void {
  if (!entity || typeof entity !== 'object') {
    return;
  }

  // Get all enumerable properties of the entity
  for (const key in entity) {
    if (entity.hasOwnProperty(key)) {
      const value = entity[key];
      
      if (typeof value === 'string') {
        entity[key] = sanitizeString(value);
      } else if (Array.isArray(value)) {
        // Sanitize arrays of strings (like topics in logs)
        entity[key] = value.map(item => 
          typeof item === 'string' ? sanitizeString(item) : item
        );
      } else if (value && typeof value === 'object' && !value.constructor?.name?.includes('Entity')) {
        // Recursively sanitize plain objects, but not other entities
        sanitizeEntityInPlace(value);
      }
    }
  }
} 