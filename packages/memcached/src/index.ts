export {
  MemcachedErrorAdapter,
  DEFAULT_KEY_PREFIX,
  DEFAULT_MAX_VALUE_BYTES,
  DEFAULT_RING_SIZE,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  counterKey,
  entryKey,
  recentSlotKeys,
  slotKey,
} from './memcached-error-adapter.js';
export type {
  MemcachedClientLike,
  MemcachedErrorOptions,
  MemcachedIncrementOptionsLike,
  MemcachedKeyOptions,
  MemcachedStoreOptionsLike,
  MemcachedStoredEntry,
} from './memcached-error-adapter.js';
