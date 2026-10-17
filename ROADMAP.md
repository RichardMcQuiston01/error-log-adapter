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
- Firebase: Firestore and Realtime Database
- Supabase: through `supabase-js` (for a direct connection, use the Postgres adapter)
- Event emitter: each entry as an event on Node `EventEmitter`, mitt, or an `EventTarget` wrapper
- WebSocket: JSON entries over a caller-owned socket (anything with `send` and `readyState`); fails descriptively when the socket is not open

## Next Up

### 1. Webhook batching

Retry with backoff, the request timeout and the HMAC signature header are shipped. Remaining work:

- Optional batching of entries into one request (needs a flush story, since `log()` resolves per entry; likely shares the cross-cutting batching wrapper below).

### 2. AWS CloudWatch Logs

- Use `PutLogEvents` through an injected client.
- Worth it for apps running outside managed AWS runtimes (Lambda and ECS already ship stdout to CloudWatch).
- Scope: one log group/stream per adapter instance; handle sequence tokens and the batch size limit.
- SNS publishing could share the same client pattern later.

## Cross-Cutting Work

- Optional retention for the Firebase adapters: a `Date` field Firestore can apply a TTL policy to, so old log documents expire on their own.
- Let the SQLite adapter share the table name validation and DDL helpers that the MySQL / Postgres adapters now have.
- Size-based rotation for the JSON file adapter's NDJSON mode (the flat file adapter already has it), ideally by sharing the rotation code.
- Fill in README Getting Started, Usage, and Examples.
- Document how to write a custom adapter.
- Add a CHANGELOG entry for each adapter release.
- Consider a shared batching/retry wrapper adapter that can sit in front of any sink.
