export type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from './types.js';
export type { SerializedErrorLogEntry } from './serialize.js';
export { serializeEntry, serializeCause } from './serialize.js';
export { ConsoleErrorAdapter } from './adapters/console-error-adapter.js';
export type { ConsoleErrorOptions } from './adapters/console-error-adapter.js';
export { WebhookErrorAdapter } from './adapters/webhook-error-adapter.js';
export type { WebhookErrorOptions } from './adapters/webhook-error-adapter.js';
export { MongoDbErrorAdapter } from './adapters/mongodb-error-adapter.js';
export type {
  CollectionLike,
  MongoDbErrorOptions,
} from './adapters/mongodb-error-adapter.js';
export { CompositeErrorAdapter } from './adapters/composite-error-adapter.js';
export {
  IndexedDbErrorAdapter,
  createErrorLogStore,
} from './adapters/indexeddb-error-adapter.js';
export type {
  IdbDatabaseLike,
  IdbObjectStoreLike,
  IdbTransactionLike,
  IdbUpgradeDatabaseLike,
  IndexedDbErrorOptions,
  IndexedDbErrorRecord,
} from './adapters/indexeddb-error-adapter.js';
export {
  SqliteErrorAdapter,
  buildCreateErrorLogTableSql,
} from './adapters/sqlite-error-adapter.js';
export type {
  SqliteClientLike,
  SqliteErrorOptions,
} from './adapters/sqlite-error-adapter.js';
export { WebStorageErrorAdapter } from './adapters/web-storage-error-adapter.js';
export type {
  StorageLike,
  WebStorageErrorOptions,
  WebStorageErrorRecord,
} from './adapters/web-storage-error-adapter.js';
export {
  FlatFileErrorAdapter,
  formatErrorLogLine,
} from './adapters/flat-file-error-adapter.js';
export type { FlatFileErrorOptions } from './adapters/flat-file-error-adapter.js';
export type { FileSystemLike, ReadWriteFileSystemLike } from './file-system.js';
export { JsonFileErrorAdapter } from './adapters/json-file-error-adapter.js';
export type {
  JsonFileErrorOptions,
  JsonFileErrorRecord,
} from './adapters/json-file-error-adapter.js';
