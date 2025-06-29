/**
 * BigInt serialization utilities for JSON and caching
 */

/**
 * Custom JSON.stringify replacer that converts BigInt to string
 */
export function bigIntReplacer(key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

/**
 * Custom JSON.parse reviver that converts string numbers back to BigInt
 * Only converts if the original field was a BigInt (heuristic: very large numbers)
 */
export function bigIntReviver(key: string, value: unknown): unknown {
  if (typeof value === 'string' && /^\d{15,}$/.test(value)) {
    // Convert strings that look like very large numbers back to BigInt
    return BigInt(value);
  }
  return value;
}

/**
 * Serialize object with BigInt support
 */
export function serializeWithBigInt(obj: unknown): string {
  return JSON.stringify(obj, bigIntReplacer);
}

/**
 * Deserialize object with BigInt support
 */
export function deserializeWithBigInt<T = unknown>(str: string): T {
  return JSON.parse(str, bigIntReviver) as T;
}

/**
 * Convert BigInt fields to strings recursively for API responses
 */
export function bigIntToString(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return obj.map(bigIntToString);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = bigIntToString(value);
    }
    return result;
  }

  return obj;
}

/**
 * Convert string fields back to BigInt for specific known fields
 */
export function stringToBigInt(obj: unknown, bigIntFields: string[] = []): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => stringToBigInt(item, bigIntFields));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (bigIntFields.includes(key) && typeof value === 'string' && /^\d+$/.test(value)) {
        result[key] = BigInt(value);
      } else {
        result[key] = stringToBigInt(value, bigIntFields);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Known BigInt fields in blockchain entities
 */
export const BLOCKCHAIN_BIGINT_FIELDS = [
  'value',
  'gas',
  'gasPrice',
  'gasUsed',
  'nonce',
  'effectiveGasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'cumulativeGasUsed',
  'transactionFee',
  'blockNumber',
  'timestamp',
  'amount',
  'balance',
  'totalSupply',
];

/**
 * Prepare object for API response (convert BigInt to string)
 */
export function prepareForApiResponse(obj: unknown): unknown {
  return bigIntToString(obj);
} 