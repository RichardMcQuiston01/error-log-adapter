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
- Batching wrapper: `BatchingErrorAdapter` queues, batches and retries in front of any adapter; the webhook adds `logBatch` (one request, JSON array)

## Next Up

Optional adapter packages under `packages/` (core stays dependency-free). RabbitMQ (`packages/rabbitmq`), NATS (`packages/nats`), ClickHouse (`packages/clickhouse`), InfluxDB (`packages/influxdb`), CouchDB (`packages/couchdb`) and ArangoDB (`packages/arangodb`) are built and await their first publish. Next, in this order: Cassandra, Neo4j. MariaDB, Percona and CockroachDB are expected to work with the MySQL and Postgres adapters and need live tests to confirm. Memcached and RethinkDB are lower priority; OrientDB is not planned.

## Cross-Cutting Work

- Fill in README Getting Started, Usage, and Examples.
- Add a CHANGELOG entry for each adapter release.
