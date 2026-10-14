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
