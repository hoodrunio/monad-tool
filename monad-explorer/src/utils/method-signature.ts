/**
 * Known ERC-20 and common contract method signatures
 */
export const KNOWN_METHOD_SIGNATURES = new Map<string, string>([
  ['0xa9059cbb', 'transfer'],
  ['0x095ea7b3', 'approve'],
  ['0x23b872dd', 'transferFrom'],
  ['0x70a08231', 'balanceOf'],
  ['0xdd62ed3e', 'allowance'],
  ['0x18160ddd', 'totalSupply'],
  ['0x06fdde03', 'name'],
  ['0x95d89b41', 'symbol'],
  ['0x313ce567', 'decimals'],
]);

/**
 * Extract method information from transaction input data
 * @param input - The transaction input data (hex string)
 * @returns Object containing method ID and name (if known)
 */
export function extractMethodInfo(input: string | null): { id: string | null; name: string | null } {
  if (!input || input.length < 10) {
    return { id: null, name: null };
  }

  const methodId = input.slice(0, 10);

  return {
    id: methodId,
    name: KNOWN_METHOD_SIGNATURES.get(methodId) || null,
  };
}
