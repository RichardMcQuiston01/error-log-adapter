# CHANGELOG

## Unreleased

### Added

- `packages/rethinkdb`: `@richardmcquiston01/error-log-adapter-rethinkdb` (0.1.0). `RethinkDbErrorAdapter(table, connection)` stores each entry as a document whose primary key is the entry id, through a `rethinkdb-ts` table, with `cause` as real JSON and `occurred_at` and `created_at` as RethinkDB's native time type (an `occurred_at` index answers "newest first"). Inserts keep the stored document when the key exists, so a retry never duplicates. RethinkDB reports a refused write as `errors > 0` in the result instead of throwing, so the adapter reads that count, and failures carry the driver's short reason instead of its message, which repeats the whole query and document. `logBatch` is one `insert` for `BatchingErrorAdapter`. Tested with a fake table, the real driver's types, and a live test against RethinkDB 2.4 in Docker.
- `packages/memcached`: `@richardmcquiston01/error-log-adapter-memcached` (0.1.0). `MemcachedErrorAdapter(client)` keeps recent errors in Memcached through a `memjs` client: each entry is JSON under `<keyPrefix><id>`, written with `add` so a repeat is a no-op, expiring after `ttlSeconds` (default seven days), with a fixed-size recent list (`ringSize`, default 100) that `recentSlotKeys` reads newest first. Memcached is a cache and may drop keys, so the README says to pair it with a durable adapter. `logBatch` stores entries in order for `BatchingErrorAdapter`. Tested with a fake client, a compile-time check against the real `memjs` types, and a live test against Memcached 1.6 in Docker.
- `packages/influxdb`: opt-in live tests, run against InfluxDB 2.9 (7 checks) and InfluxDB 3 Core (6 checks) servers in Docker. They are skipped unless `INFLUXDB_TEST_URL` or `INFLUXDB3_TEST_URL` is set.
- `packages/nats`: an opt-in live test, run against NATS 2.15 and 2.10 servers with JetStream in Docker (all nine checks pass). It is skipped unless `NATS_TEST_URL` is set.
- `packages/couchdb`: an opt-in live test, run against CouchDB 3.5 and 3.3 servers in Docker (all seven checks pass). It is skipped unless `COUCHDB_TEST_URL` is set.
- `packages/rabbitmq`: an opt-in live test, run against RabbitMQ 3.13 and 4.4 brokers in Docker (all eight checks pass). It is skipped unless `RABBITMQ_TEST_URL` is set.
- `packages/clickhouse`: an opt-in live test, run against ClickHouse 26.9 and 24.8 servers in Docker (all nine checks pass). It is skipped unless `CLICKHOUSE_TEST_URL` is set.
- `packages/cassandra`: an opt-in live test, run against Cassandra 5 and 4.1 servers in Docker (all eight checks pass). It is skipped unless `CASSANDRA_TEST_HOST` is set.
- `packages/arangodb`: an opt-in live test, run against ArangoDB 3.12 and 3.11 servers in Docker (all seven checks pass). It is skipped unless `ARANGODB_TEST_URL` is set.
- `packages/neo4j`: an opt-in live test, run against Neo4j 5 and 4.4 servers in Docker (all five checks pass). It is skipped unless `NEO4J_TEST_URL` is set.

## 0.15.1

### Fixed

- `WebStorageErrorAdapter`: a failed write inside the `navigator.locks` callback no longer leaves the lock held. Node 24 and later keep a Web Lock forever when its callback throws synchronously, so after one failed write every later `log` in the process waited for ever (browsers release the lock). The callback is now async, so the error comes back as a rejection and the lock is released. This showed up as nine timing-out tests on CI once its runner moved to Node 24.

### Added

- `RedisErrorAdapter`, `MongoDbErrorAdapter` and `SqliteErrorAdapter`: live tests against real engines. Redis (`REDIS_TEST_URL`) and MongoDB (`MONGODB_TEST_URL`) are opt-in and passed on Redis 6.2 and 7.4, Valkey 8 and MongoDB 7 and 8.3 in Docker; they check list and stream modes, `maxEntries` on both sides, awkward text, repeats, a refused command, and an unreachable server for Redis, and `_id` handling, duplicate-key retries, a non-retry duplicate-key error and an unreachable server for MongoDB. The SQLite test needs no server: it runs against `node:sqlite` whenever Node has it (the test is skipped otherwise) and checks the table and index, columns, long and awkward text, repeats, your own DDL, concurrent first use, a missing table and a closed database. The documented `bun:sqlite` fit was also confirmed with a one-off script.
- `MySqlErrorAdapter` and `PostgresErrorAdapter`: an opt-in live test (`MYSQL_TEST_URL`, `POSTGRES_TEST_URL`), run against MariaDB 10.11 and 11, Percona Server 8.0, MySQL 8.4, Postgres 16 and CockroachDB 26.3 in Docker. It checks the table and index, the row's columns, JSON causes, long and awkward text (including 4-byte characters), a repeated id keeping the first row, your own DDL with `createTable: false`, entries logged at the same time, and a missing table, a wrong login and an unreachable server coming back as `ok: false`. All pass, so MariaDB, Percona and CockroachDB are now documented as supported.

## nats-v0.1.1

### Fixed

- `packages/nats`: `NatsJetStreamErrorAdapter` now explains the bare `503` that the `nats` client raises when no stream captures the subject (or JetStream is off on the server) instead of returning just `503`. The result says what the 503 means and how to fix it.

## neo4j-v0.1.0

### Added

- `packages/neo4j`: `@richardmcquiston01/error-log-adapter-neo4j` (0.1.0). `Neo4jErrorAdapter(driver)` writes each entry as an `:ErrorLog` node through the official `neo4j-driver` (`executeQuery`, write routing), creating a uniqueness constraint on `id` and an index on `occurred_at` on first use. Writes are `MERGE ... ON CREATE SET`, so a repeat of the same entry never duplicates. `logBatch` writes all entries in one `UNWIND` query (one transaction) for `BatchingErrorAdapter`, and `buildNeo4jSchemaStatements()` returns the schema statements. Tested with a fake driver, a compile-time check against the real driver types, and Neo4j's own Cypher parser; not run against a Neo4j server.

## 0.15.0

### Changed

- The `Publish` workflow now publishes whatever the release tag names: `v<version>` publishes this package and `<package>-v<version>` publishes `packages/<package>`. `scripts/resolve-release.ts` checks the tag against `package.json` (and an adapter package's peer range against this package's version), `scripts/check-pack.ts` checks each tarball in CI and before publishing, and each package copies the repository `LICENSE` in with a `prepack` script. See `docs/releasing.md`.

### Removed

- `formatErrorLogLine` is no longer exported from the package entry point. It is how `FlatFileErrorAdapter` writes a line; pass `formatLine` to change that. **Breaking** for code that imported it.

### Added

- `packages/cassandra`: `@richardmcquiston01/error-log-adapter-cassandra` (0.1.0). `CassandraErrorAdapter(client)` writes each entry as a row of a time-bucketed `error_log` table (`PRIMARY KEY ((bucket), occurred_at, id)`, newest first, partitions per hour, day or month) through the DataStax `cassandra-driver`, creating the table on first use. Inserts are prepared, leave out an absent `cause` or `source` (no tombstones), and take an optional `ttlSeconds` and `consistency`. A repeat of the same entry (same id and timestamp) rewrites the same row. `logBatch` sends each partition's rows as unlogged batches for `BatchingErrorAdapter`, and `buildCassandraTableDdl()` returns the `CREATE TABLE` statement. Tested with a fake client and a compile-time check against the real driver types; not run against a Cassandra server.
- `packages/arangodb`: `@richardmcquiston01/error-log-adapter-arangodb` (0.1.0). `ArangoDbErrorAdapter(collection)` stores each entry as an ArangoDB document through an `arangojs` collection handle, with the entry UUID as `_key` (`code`, `message`, `cause` as JSON, `source`, `occurred_at`, `created_at`). Inserts use `overwriteMode: 'ignore'`, and a "key already exists" error from an older server counts as success, so retries never duplicate. Failures carry ArangoDB's error number and HTTP status. `logBatch` uses one `saveAll` request for `BatchingErrorAdapter`, and `buildErrorLogIndex()` returns a persistent index for time queries. Tested with the real `arangojs` client against a stand-in for ArangoDB's document API; not run against an ArangoDB server.
- `packages/couchdb`: `@richardmcquiston01/error-log-adapter-couchdb` (0.1.0). `CouchDbErrorAdapter(database)` stores each entry as a CouchDB document through a `nano` database handle, with the entry UUID as `_id` (`type`, `code`, `message`, `cause` as JSON, `source`, `occurred_at`, `created_at`). A conflict on an existing id counts as success, so retries never duplicate. Failures carry CouchDB's HTTP status and reason. `logBatch` uses one `_bulk_docs` request for `BatchingErrorAdapter`, and `buildErrorLogIndex()` returns a Mango index for time queries. Tested with the real `nano` client against an in-memory stand-in, and run against PouchDB Server.
- `packages/influxdb`: `@richardmcquiston01/error-log-adapter-influxdb` (0.1.0). `InfluxDbErrorAdapter(writeApi)` writes through an InfluxDB 2.x `WriteApi` (`@influxdata/influxdb-client`) and `InfluxDb3ErrorAdapter(client)` through an InfluxDB 3 `InfluxDBClient` (`@influxdata/influxdb3-client`). Each entry is one point (`error_log`, tags `code` and `source`, fields `id`, `message` and `cause`); with `ns` or `us` precision the sub-millisecond part of the timestamp comes from the entry id, so same-time errors do not overwrite each other and a retry overwrites instead of duplicating. Both wait for the write to be accepted and report rejections, and have `logBatch` for `BatchingErrorAdapter`. Tests run both real clients against a local stub HTTP server.
- `packages/clickhouse`: `@richardmcquiston01/error-log-adapter-clickhouse` (0.1.0). `ClickHouseErrorAdapter(client, options)` inserts each entry as a row in an `error_log` table (`id UUID`, `code`, `message`, `cause`, `source`, `occurred_at`, `created_at`; `ReplacingMergeTree`, monthly partitions, optional `ttlDays`) through the official `@clickhouse/client`, creating the table on first use. Inserts use asynchronous inserts by default (`clickhouseSettings`), and `logBatch` writes a whole batch in one insert for `BatchingErrorAdapter`. `buildClickHouseTableDdl()` returns the `CREATE TABLE` statement for your own migration. The statement and row shape were run against an embedded ClickHouse engine.
- `packages/nats`: `@richardmcquiston01/error-log-adapter-nats` (0.1.0). `NatsErrorAdapter(connection, subject)` publishes each entry as JSON to a core NATS subject (fire-and-forget; `flush: true` waits for the connection to reach the server). `NatsJetStreamErrorAdapter(jetstream, subject)` waits for the stream's acknowledgement and sends the entry `id` as `Nats-Msg-Id`, so the stream drops repeats inside its duplicate window. Both can send `code` / `source` as headers (`createHeaders`, pass `headers` from `nats`) and have `logBatch` for `BatchingErrorAdapter`.
- `packages/rabbitmq`: `@richardmcquiston01/error-log-adapter-rabbitmq` (0.1.0). `RabbitMqErrorAdapter(channel, options)` publishes each entry as a JSON message through an amqplib `Channel` or `ConfirmChannel`, with the entry `id` as the message id, the `code` as the message type and `code` / `source` as headers. `confirm: true` waits for the broker's acknowledgement; `logBatch` lets `BatchingErrorAdapter` wrap it. Root `build:packages` and `typecheck` now cover every package, and a root `vitest.config.ts` resolves the core by name to the source so package tests need no build.
- `docs/versioning-policy.md` (what is public, Stable and Experimental, version numbers, support, deprecation) and `SECURITY.md` (private vulnerability reporting).
- Compile-time checks that the real `mongodb`, `mysql2`, `pg`, `redis`, `@supabase/supabase-js`, `firebase-admin`, `ws` and DOM client types fit the `...Like` interfaces. With them every adapter meets the rule for Stable in the policy. Dev-only; nothing changes in the published package.
- The publish workflow publishes a prerelease version (for example `1.0.0-rc.1`) under the `next` npm tag instead of `latest`.
- `@richardmcquiston01/error-log-adapter/kit` exports the helpers the built-in adapters use (`reportFailure`, `withTimeout`, `resolveTimeoutMs`, `timeoutMessage`, `SinkTimeoutError`, `resolveEntryId`, `hasCallerId`, `generateId`, `describeError`, `backoffDelayMs`, `SerialQueue`, `assertIdentifier` and the related defaults), so adapter packages published separately behave the same way as the built-in ones. Nothing changes for code that imports the main entry point.
- The repository is now a bun workspace: optional adapter packages go under `packages/`, each depending on the core as a peer dependency. See `packages/README.md`.

## 0.14.0

### Added

- `SnsErrorAdapter.logBatch(entries)` publishes several entries with `PublishBatch` (up to 10 messages and 256 KiB per request, split automatically), so `BatchingErrorAdapter` now delivers a batch in a few requests instead of one per entry. Every entry is checked before anything is sent; after that the call stops at the first failing request (including messages SNS refuses inside an accepted request) and reports how many entries were already published. `SnsClientLike` gains an optional `publishBatch`; a client without it still works, with the entries published one by one. Exports `SnsPublishBatchEntry` and `SnsPublishBatchInput`.
- Opt-in live test for the SNS adapter: it creates topics and SQS queues, publishes through `SnsErrorAdapter`, and reads the messages back (the JSON message, subject and `code` / `source` attributes, a subscription filter policy picking entries by code, FIFO deduplication by entry id, and a missing topic). Skipped unless `SNS_TEST_REGION` is set; run with `npm run test:live`. Dev-only (adds `@aws-sdk/client-sns` and `@aws-sdk/client-sqs` as dev dependencies); nothing changes in the published package.

## 0.13.0

### Added

- `SnsErrorAdapter(client, topicArn)` publishes each entry to an Amazon SNS topic as a JSON message (the serialized entry plus its UUID `id`) through an injected client (`publish`; the AWS SDK v3 `SNS` client fits as it is). The entry's `code` and `source` are sent as message attributes so subscription filter policies can route on them (`attributes: false` turns it off), and the subject is `<code>: <message>` cut to what SNS accepts (`subject: false` leaves it out). FIFO topics need `messageGroupId` and use the entry's `id` as the deduplication id. A message over 256 KiB, attributes included, is refused before sending, and the topic ARN is checked in the constructor. Exports `SnsClientLike`, `SnsErrorOptions`, `SnsMessageAttribute` and `SnsPublishInput`.
- Opt-in live tests for the CloudWatch Logs adapter (group and stream creation, batching, the too-old rejection, a missing group) and the Firestore adapter (documents keyed by id, the `expire_at` timestamp field, a custom `expireField`, same-id overwrite). They are skipped unless `CLOUDWATCH_TEST_REGION` or `FIRESTORE_TEST_PROJECT_ID` is set, and run with `npm run test:live`, which now runs every `*.live.test.ts` file. Dev-only; nothing changes in the published package.

## 0.12.0

### Changed

- The Postgres, MySQL and SQLite adapters now share one base class (`SqlTableAdapter`, internal): the `error_log` row, creating the table once and retrying after a failure, the keep-the-first-row insert, and the `timeoutMs` handling were written out three times and now live in one place. Each adapter keeps its own SQL, so the DDL, the `INSERT` text, the stored values and the public exports are unchanged. One small difference: `SqliteErrorAdapter` now checks the entry (for example an invalid `id`) before it creates the table, as the Postgres and MySQL adapters already did, so a bad entry no longer creates an empty table as a side effect.

## 0.11.0

### Added

- `JsonFileErrorAdapter` options `maxBytes` and `maxFiles` for `ndjson` mode: rotate the file by size, the same way `FlatFileErrorAdapter` does (`errors.ndjson` becomes `errors.ndjson.1`, older files shift up, the oldest is deleted). Every file holds whole lines, and a failed rotation is reported but the entry is still written. Off by default; `array` mode rejects both options.

### Changed

- The rotation code is now shared by the flat file and JSON file adapters. `FlatFileErrorAdapter` behaves as before, including its error messages.

## 0.10.0

### Added

- `FirestoreErrorAdapter` options `expireAfterMs` and `expireField`: add an expiry timestamp (the entry's `timestamp` plus `expireAfterMs`, stored as a Firestore timestamp in `expire_at` by default) to every document, for a Firestore TTL policy to act on. Nothing is deleted until you enable the policy on that field. Off by default. The Realtime Database has no TTL feature, so it is not affected. New exported types `FirestoreErrorOptions` and `FirestoreErrorRecord`.

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
