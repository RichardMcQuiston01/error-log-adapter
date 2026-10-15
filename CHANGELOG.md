# CHANGELOG

## Unreleased

- `FirestoreErrorAdapter` and `RealtimeDatabaseErrorAdapter` write entries to Firebase. A `firebase-admin` Firestore collection or Realtime Database reference works as it is; the web SDK needs a small wrapper, shown in the docs. Firestore documents use the entry's UUID as their id, so a retried write cannot duplicate. The Realtime Database uses `push` keys, which sort by time. The cause is stored as a JSON string so no cause can break a write. Both give up with a clear error if a write is not saved within `timeoutMs` (default 10 seconds), because the Firebase SDKs queue writes while offline and would otherwise leave `log` waiting for the whole outage.

## 0.3.0

- `S3ErrorAdapter` stores entries in S3 and S3-compatible buckets (DigitalOcean Spaces, Cloudflare R2, MinIO) through a one-method `putObject` client, which the AWS SDK v3 `S3` client already provides. By default each entry is its own JSON object keyed `<keyPrefix>YYYY/MM/DD/<timestamp>-<uuid>.json`. With `batch`, entries are buffered and uploaded together as one newline-delimited JSON object when `batchSize` is reached or `maxWaitMs` passes; `flush()` uploads what is buffered, and entries from a failed upload are kept and retried.
- `RedisErrorAdapter` writes entries to Redis through a one-method `sendCommand(args)` client, which node-redis already provides (ioredis needs a one-line wrapper, shown in the docs). `list` mode (default) pushes one JSON record per entry with `RPUSH` or `LPUSH` and trims to `maxEntries` with `LTRIM`. `stream` mode appends each entry with `XADD` and an exact `MAXLEN` cap.
- `PostgresErrorAdapter` and `MySqlErrorAdapter` write entries to Postgres and MySQL / MariaDB through a one-method `query(sql, params)` client, which `pg` and `mysql2/promise` pools and connections already provide. Rows go into a singular `error_log` table: a native `UUID` key and `JSONB` / `TIMESTAMPTZ` columns on Postgres, a `CHAR(36)` key and `JSON` / `DATETIME(3)` (UTC) columns on MySQL. The table is created on first use, or run `buildErrorLogTableDdl(dialect)` yourself.

## 0.2.0

- `JsonFileErrorAdapter` stores entries as JSON in a file (Node and Bun). `ndjson` mode (default) appends one compact object per line. `array` mode keeps one indented JSON array, rewritten safely through a temporary file, with an optional `maxEntries` cap. A file that is not valid JSON is moved to `<path>.corrupt` instead of being overwritten.
- `FlatFileErrorAdapter` appends one text line per entry to a file (Node and Bun). Options: custom `formatLine`, size-based rotation (`maxBytes` / `maxFiles`), and automatic parent folder creation. Writes are queued so concurrent calls stay in order.
- `WebStorageErrorAdapter` for `sessionStorage` and `localStorage`. Entries are kept as a JSON array under one key, capped at `maxEntries` (default 100). When the store is full, the oldest entries are dropped until the new one fits.
- `SqliteErrorAdapter` for any SQLite driver through a one-method `run(sql, params)` client, plus `buildCreateErrorLogTableSql` for running your own migration. Rows go into a singular `error_log` table with a UUID `id`, snake_case columns, and `occurred_at` / `created_at` timestamps.
- `IndexedDbErrorAdapter` for browser storage, plus a `createErrorLogStore` helper for `onupgradeneeded`. Records get a UUID `id` key and a `timestamp` index.

## 0.1.0

- Initial release, extracted from [chat-and-react](https://github.com/RichardMcQuiston01/chat-and-react).
- `ErrorLogAdapter` interface with generic error codes. `log` returns a `Promise<ErrorLogResult>` that never rejects.
- `ConsoleErrorAdapter`, `WebhookErrorAdapter`, `MongoDbErrorAdapter`, and `CompositeErrorAdapter`.
- Configurable log prefix; `Error` causes are serialized so they survive JSON.
