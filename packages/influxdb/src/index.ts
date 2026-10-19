export {
  InfluxDbErrorAdapter,
  InfluxDb3ErrorAdapter,
} from './influxdb-error-adapter.js';
export type {
  InfluxDb3ClientLike,
  InfluxDb3ErrorOptions,
  InfluxDb3WriteOptionsLike,
  InfluxDbErrorOptions,
  InfluxWriteApiLike,
} from './influxdb-error-adapter.js';
export {
  DEFAULT_MEASUREMENT,
  buildErrorLogLine,
  pointTimestamp,
} from './line-protocol.js';
export type { InfluxPrecision } from './line-protocol.js';
