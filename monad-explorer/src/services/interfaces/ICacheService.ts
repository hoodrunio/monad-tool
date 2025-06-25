/**
 * Interface for cache service operations
 * Following Interface Segregation Principle - focused on caching only
 */
export interface ICacheService {
  /**
   * Gets a value from cache
   * @param key - The cache key
   * @returns Promise with cached value or null if not found
   */
  get<T>(key: string): Promise<T | null>

  /**
   * Sets a value in cache with optional TTL
   * @param key - The cache key
   * @param value - The value to cache
   * @param ttlSeconds - Time to live in seconds (optional)
   * @returns Promise with boolean indicating success
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean>

  /**
   * Deletes a value from cache
   * @param key - The cache key
   * @returns Promise with boolean indicating if key was deleted
   */
  delete(key: string): Promise<boolean>

  /**
   * Checks if a key exists in cache
   * @param key - The cache key
   * @returns Promise with boolean indicating if key exists
   */
  exists(key: string): Promise<boolean>

  /**
   * Gets multiple values from cache
   * @param keys - Array of cache keys
   * @returns Promise with array of values (null for missing keys)
   */
  mget<T>(keys: string[]): Promise<(T | null)[]>

  /**
   * Sets multiple values in cache
   * @param keyValuePairs - Object with key-value pairs
   * @param ttlSeconds - Time to live in seconds (optional)
   * @returns Promise with boolean indicating success
   */
  mset<T>(keyValuePairs: Record<string, T>, ttlSeconds?: number): Promise<boolean>
} 