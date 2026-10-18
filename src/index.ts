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
export type { CompositeErrorOptions } from './adapters/composite-error-adapter.js';
export {
  IndexedDbErrorAdapter,
  createErrorLogStore,
} from './adapters/indexeddb-error-adapter.js';
export type {
  IdbDatabaseLike,
  IdbObjectStoreLike,
  IdbRequestLike,
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
  LockManagerLike,
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
export {
  MySqlErrorAdapter,
  PostgresErrorAdapter,
  buildErrorLogTableDdl,
  buildMySqlWidenColumnsSql,
} from './adapters/sql-error-adapter.js';
export type {
  SqlClientLike,
  SqlDialect,
  SqlErrorOptions,
} from './adapters/sql-error-adapter.js';
export { RedisErrorAdapter } from './adapters/redis-error-adapter.js';
export type {
  RedisClientLike,
  RedisErrorOptions,
} from './adapters/redis-error-adapter.js';
export { S3ErrorAdapter } from './adapters/s3-error-adapter.js';
export type {
  S3BatchOptions,
  S3ClientLike,
  S3ErrorOptions,
  S3PutObjectInput,
} from './adapters/s3-error-adapter.js';
export {
  FirestoreErrorAdapter,
  RealtimeDatabaseErrorAdapter,
} from './adapters/firebase-error-adapter.js';
export type {
  FirebaseErrorOptions,
  FirebaseErrorRecord,
  FirestoreCollectionLike,
  FirestoreErrorOptions,
  FirestoreErrorRecord,
  RealtimeDatabaseRefLike,
} from './adapters/firebase-error-adapter.js';
export {
  SupabaseErrorAdapter,
  buildSupabaseSetupSql,
} from './adapters/supabase-error-adapter.js';
export type {
  SupabaseClientLike,
  SupabaseErrorLike,
  SupabaseErrorOptions,
  SupabaseErrorRow,
  SupabaseInsertResult,
  SupabaseSetupOptions,
} from './adapters/supabase-error-adapter.js';
export { EventEmitterErrorAdapter } from './adapters/event-emitter-error-adapter.js';
export type {
  EmitterLike,
  EventEmitterErrorOptions,
  EventEmitterErrorRecord,
} from './adapters/event-emitter-error-adapter.js';
export { WebSocketErrorAdapter } from './adapters/websocket-error-adapter.js';
export type {
  WebSocketErrorOptions,
  WebSocketLike,
} from './adapters/websocket-error-adapter.js';
export { CloudWatchLogsErrorAdapter } from './adapters/cloudwatch-logs-error-adapter.js';
export type {
  CloudWatchBatchOptions,
  CloudWatchLogEvent,
  CloudWatchLogsClientLike,
  CloudWatchLogsErrorOptions,
  CloudWatchPutLogEventsInput,
} from './adapters/cloudwatch-logs-error-adapter.js';
export { SnsErrorAdapter } from './adapters/sns-error-adapter.js';
export type {
  SnsClientLike,
  SnsErrorOptions,
  SnsMessageAttribute,
  SnsPublishInput,
} from './adapters/sns-error-adapter.js';
export { BatchingErrorAdapter } from './adapters/batching-error-adapter.js';
export type {
  BatchCapableAdapter,
  BatchingErrorOptions,
} from './adapters/batching-error-adapter.js';
