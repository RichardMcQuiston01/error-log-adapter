# CHANGELOG

## 0.9.0

### Added

- `BatchingErrorAdapter` puts a queue in front of any adapter. `log()` returns `ok: true` once the entry is queued, and entries are delivered in order in batches (`batchSize`, `maxWaitMs`) with exponential-backoff retries (`retries`, `retryDelayMs`, `maxRetryDelayMs`). Entries that fail every attempt, or are pushed out of a full buffer (`maxBuffered`), go to `onDrop` and the console, and `flush()` reports them once. It stops a batch at the first failure so a dead sink is not hammered, and uses the wrapped adapter's `logBatch` when it has one. `ok: true` means queued, not stored; call `flush()` before exiting.
- `WebhookErrorAdapter.logBatch(entries)` sends several entries as one request carrying a JSON array of the usual records (each with an `id`), with the same retries, timeout and signing as `log`. `BatchingErrorAdapter` uses it automatically, so a wrapped webhook receives arrays; pass `useBatchMethod: false` for one request per entry.
- `BatchCapableAdapter` type for adapters that offer `logBatch`.
- [docs/custom-adapters.md](./docs/custom-adapters.md): a guide to writing your own adapter (the contract, timeouts, entry ids and safe retries, buffering adapters, testing, a checklist), linked from the README.

## 0.8.0

### Added

- `CloudWatchLogsErrorAdapter` sends each entry to one AWS CloudWatch Logs stream through `PutLogEvents`, as a JSON event (the serialized entry plus its UUID `id`) stamped with the entry's time. It takes an AWS SDK v3 `CloudWatchLogs` client, so there is no new dependency. It creates a missing stream or group and tries again (`createMissing`, on by default), reports events CloudWatch accepts the request for but rejects (too old or too new) as `ok: false`, and refuses an event over the 256 KiB limit before sending. Optional `batch` buffers events and sends them oldest first within the 10,000 event, 1 MiB and 24 hour limits of one request; call `flush()` before exiting. Also takes `timeoutMs`.

## 0.7.0

### Added

- `WebSocketErrorAdapter` sends each entry as one JSON message (the serialized entry plus its UUID `id`) over a socket you own: the browser `WebSocket`, Node's global `WebSocket`, Deno, Bun or `ws`, since it only needs `send` and `readyState`. It never connects or buffers; when the socket is not open, `log` returns `ok: false` and says whether it is connecting, closing or closed. `ok: true` means the socket accepted the message, not that the server received it.

## 0.6.0

### Added

- `WebhookErrorAdapter` options `retries`, `retryDelayMs` and `maxRetryDelayMs`: retry network errors, timeouts, HTTP 408/425/429 and 5xx with exponential backoff and jitter, honoring `Retry-After`. All attempts send the same body, which includes an `id` when retries are on.
- `WebhookErrorAdapter` option `signingSecret`: signs each request with `X-Signature-Timestamp` and `X-Signature-256` (HMAC-SHA256 of `<timestamp>.<body>`).
- `EventEmitterErrorAdapter` emits each entry as an `error-log` event on an emitter you own, for in-process hooks such as a toast, a metrics counter or a test assertion. Anything with `emit(name, payload)` works: Node's `EventEmitter` and mitt as they are, a browser `EventTarget` through a one-line wrapper. The payload is the stored record (UUID `id` plus the serialized entry), and a caller-supplied `id` is passed through. Listeners run synchronously, so one that throws makes `log` return `ok: false` with its message. Options: `eventName`, and `requireListener` to report an emit that reached nobody (Node's `emit` returns `false`) as a failure.

## 0.5.0

### Added

- `ErrorLogEntry.id`: an optional UUID that identifies an entry. Without it every `log` call gets a new random id, as before. With it, logging the same entry again is safe on the sinks that can tell: Postgres, MySQL and SQLite store it once (`ON CONFLICT` / `ON DUPLICATE KEY`), MongoDB and Supabase count a duplicate key as success, Firestore and the Realtime Database overwrite the same document or key, IndexedDB, Web Storage and the JSON `array` file replace the earlier record, and the webhook sends the `id` in its body. S3 overwrites the same object only when the retry also has the same `timestamp`. Redis, the flat file, the NDJSON file and the console cannot detect a repeat. An `id` that is not a UUID makes `log` return `ok: false`. A Realtime Database reference needs `child(key).set(value)` for entries that carry an `id`.
- `timeoutMs` (default 10 000 ms, `Infinity` to wait without limit) on the webhook, MongoDB, Postgres, MySQL, SQLite, Supabase, Redis, S3 and IndexedDB adapters, so `log` can no longer hang when a sink stalls. A timeout returns `ok: false` and says the entry may or may not have been stored. The webhook aborts its request; the others stop waiting, since drivers cannot cancel a call. `CompositeErrorAdapter` takes `{ timeoutMs }` too (default 30 000 ms) so one hung adapter cannot hold back the others. The Firebase adapters use the same helper.
- `WebhookErrorAdapter` option `allowInsecure`, `WebStorageErrorAdapter` option `locks`, `buildMySqlWidenColumnsSql`, `SupabaseSetupOptions.allowPublicInsert`, and the exported types `CompositeErrorOptions`, `LockManagerLike` and `IdbRequestLike`.
- A `test-windows` CI job, CI on pushes to `dev`, and GitHub Actions pinned to commit SHAs with Dependabot keeping the pins current.

### Changed

- **Webhook:** the URL must be `https://` (or `http://localhost`, `127.0.0.1`, `[::1]`) unless `allowInsecure: true`; an invalid or other URL throws a `RangeError` from the constructor. Redirects are no longer followed: a 301, 302, 303, 307 or 308 returns `ok: false` instead of delivering a body-less `GET` (302, 303) or re-sending the entry and your headers to another host (307, 308). Failure messages contain only the origin, never the path or query, because webhook URLs often hold a secret.
- **Supabase:** `buildSupabaseSetupSql` no longer emits `WITH CHECK (true)`. Any policy limits `code` and `source` to 255 characters, `message` to 4096 and `cause` to 8192 bytes, and listing `anon` or `public` in `insertRoles` throws unless `allowPublicInsert: true`. Prefer `authenticated`, or log from a server with the service role key. `SupabaseErrorAdapter` now rejects a `tableName` that is not letters, digits and underscores in the constructor instead of at insert time.
- **MySQL:** `code` and `source` are `TEXT` instead of `VARCHAR(255)`, so a long source URL no longer makes the insert fail. Tables created by 0.4.0 or earlier keep the old columns; run the statement from `buildMySqlWidenColumnsSql()` once.
- `serializeEntry` and `serializeCause` always return something `JSON.stringify` accepts. Nested `Error.cause` chains and `AggregateError.errors` are kept, an `Error` inside a plain object or array (or from another realm) is no longer stored as `{}`, and circular references, `BigInt`, `Symbol`, functions and throwing getters become short markers (`[Circular]`, `[Truncated]` past 6 levels) instead of making `log` return `ok: false`.
- **IndexedDB:** a failed write reports the real error (`request failed: ConstraintError: ...` instead of `no details provided`), and the error events are handled so a failed log write no longer reaches an application's own `onerror` on the database.
- **Web Storage:** an unreadable stored value is copied to `<key>.corrupt` before it is replaced, writes take a `navigator.locks` lock when the browser has one (this reduces lost entries between `localStorage` tabs but cannot remove them), and a UUID is generated even on an insecure `http://` page, where `crypto.randomUUID` does not exist.
- Firestore and Realtime Database: the timeout message and docs no longer imply a retried `log` cannot duplicate; give the entry an `id` for that.
- Internal: shared identifier checks, failure reporting and a serial write queue replace code that was copied between adapters. Error messages are unchanged.

### Fixed

- The flat file and JSON file adapters failed on every call for a file at the root of a Windows drive (`C:\error.log`), because `mkdir` was attempted on `C:`.
- README now documents every adapter, the `id` field, timeouts and the per-adapter options.

## 0.4.0

- `SupabaseErrorAdapter` writes entries to a Supabase table through `supabase-js` (any client with `from(table).insert(row)` works). Rows use the same columns as the Postgres adapter's `error_log` table. `supabase-js` returns failures instead of throwing, so the adapter reads the returned error and reports its message, code, details and hint, or the HTTP status when the error has no message. `buildSupabaseSetupSql` returns the SQL to run once in the Supabase SQL editor: the table, row level security, and an optional insert-only policy for roles such as `anon`. Checked against a real PostgREST server with `supabase-js` 2.118, including a row level security rejection, a missing table, a bad key and an unreachable server.
- `FirestoreErrorAdapter` and `RealtimeDatabaseErrorAdapter` write entries to Firebase. A `firebase-admin` Firestore collection or Realtime Database reference works as it is; the web SDK needs a small wrapper, shown in the docs. Firestore documents use the entry's UUID as their id, so the SDK finishing one queued write twice cannot create two documents; logging the same entry again is a new write with a new id. The Realtime Database uses `push` keys, which sort by time. The cause is stored as a JSON string so no cause can break a write. Both give up with a clear error if a write is not saved within `timeoutMs` (default 10 seconds), because the Firebase SDKs queue writes while offline and would otherwise leave `log` waiting for the whole outage.

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
