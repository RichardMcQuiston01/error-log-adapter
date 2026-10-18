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
- Batching wrapper: `BatchingErrorAdapter` queues, batches and retries in front of any adapter; the webhook adds `logBatch` (one request, JSON array)

## Next Up

Nothing is queued. Candidates are under Cross-Cutting Work.

## Cross-Cutting Work

- Let the SQLite adapter share the table name validation and DDL helpers that the MySQL / Postgres adapters now have.
- Size-based rotation for the JSON file adapter's NDJSON mode (the flat file adapter already has it), ideally by sharing the rotation code.
- Fill in README Getting Started, Usage, and Examples.
- Add a CHANGELOG entry for each adapter release.
- SNS publishing could follow the CloudWatch Logs adapter's injected-client pattern.
