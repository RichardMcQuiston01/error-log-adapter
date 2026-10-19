# ROADMAP

Planned adapters, in priority order.

## Design Principles

- **Dependency-free core.** Drivers (SQLite, Postgres, Redis, AWS SDK, Firebase) are never imported by the library. Each adapter accepts a minimal structural interface, like `CollectionLike` in the MongoDB adapter, so users bring their own client.
- **Never throw.** Every adapter returns `{ ok, error? }` with a descriptive error message.
- **Shared record shape.** Every adapter stores `SerializedErrorLogEntry`.
- **Tested.** Each adapter ships with unit tests against a fake client.
- **SQL conventions.** Singular table name (`error_log`), `snake_case` columns, UUID primary key, `created_at` timestamp.

## Already Shipped

- Console
- Webhook
- MongoDB
- Composite (fan-out to several adapters)
- IndexedDB
- SQLite
- Web Storage (`sessionStorage` / `localStorage`)
- Flat file (Node/Bun)
- JSON file (Node/Bun): newline-delimited JSON or a single array
- MySQL / Postgres
- Redis: capped list or stream
- S3 / DigitalOcean Spaces (and other S3-compatible stores): one object per entry or batched
- Firebase: Firestore and Realtime Database (Firestore can add an expiry timestamp field for a TTL policy)
- Supabase: through `supabase-js` (for a direct connection, use the Postgres adapter)
- Event emitter: each entry as an event on Node `EventEmitter`, mitt, or an `EventTarget` wrapper
- WebSocket: JSON entries over a caller-owned socket (anything with `send` and `readyState`); fails descriptively when the socket is not open
- AWS CloudWatch Logs: `PutLogEvents` through an injected client, one group/stream per adapter, optional batching within the request limits
- AWS SNS: `Publish` through an injected client, `code` and `source` as filterable message attributes, FIFO topics with deduplication by entry id
- `/kit` entry point: the helpers adapter packages build on (experimental until the packages have settled)
- Optional adapter packages (each has its own README under `packages/` and is versioned on its own):
  - `@richardmcquiston01/error-log-adapter-rabbitmq` 0.1.0: RabbitMQ through an `amqplib` channel, with optional broker confirms
  - `@richardmcquiston01/error-log-adapter-nats` 0.1.0: core NATS, and JetStream with de-duplication by entry id
  - `@richardmcquiston01/error-log-adapter-clickhouse` 0.1.0: a `ReplacingMergeTree` table with async inserts and a one-insert `logBatch`
  - `@richardmcquiston01/error-log-adapter-influxdb` 0.1.0: InfluxDB 2.x and 3 points
  - `@richardmcquiston01/error-log-adapter-couchdb` 0.1.0: documents keyed by entry id, so retries never duplicate
  - `@richardmcquiston01/error-log-adapter-arangodb` 0.1.0: documents keyed by entry id
  - `@richardmcquiston01/error-log-adapter-cassandra` 0.1.0: a time-bucketed table
  - `@richardmcquiston01/error-log-adapter-neo4j` 0.1.0: `:ErrorLog` nodes, `MERGE` on the entry id so retries never duplicate
- Batching wrapper: `BatchingErrorAdapter` queues, batches and retries in front of any adapter; the webhook adds `logBatch` (one request, JSON array)

## Next Up

- **MariaDB, Percona and CockroachDB** are expected to work with the MySQL and Postgres adapters. They need live tests against the real servers to confirm, then a line in the README.
- Memcached and RethinkDB are lower priority; OrientDB is not planned.
- Adapter packages that have not been run against a live server (ArangoDB, Cassandra, InfluxDB, NATS, CouchDB, RabbitMQ and ClickHouse each say what they were and were not tested against in their README) would benefit from opt-in live tests, like the ones for S3, SNS, CloudWatch Logs and Firestore.

## Cross-Cutting Work

- Fill in README Getting Started, Usage, and Examples.
- Add a CHANGELOG entry for each adapter release.
