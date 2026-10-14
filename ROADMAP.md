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

## Next Up

### 1. sessionStorage (browser)

- Append entries under a configurable key.
- Cap the number of stored entries (ring buffer) and handle `QuotaExceededError`.
- Accept a `Storage`-like object so it can also wrap `localStorage`.

### 2. Flat file (Node/Bun)

- Append one line per entry to a text file.
- Options: path, line format, optional size-based rotation.

### 3. JSON file (Node/Bun)

- Append entries as newline-delimited JSON (NDJSON), which is cheap to append and easy to parse.
- Optional single-array JSON mode, rewritten on each write.

### 4. MySQL / Postgres

- Shared SQL core with per-dialect placeholder handling (`?` vs `$1`).
- Accept a minimal `query(sql, params)` client, so it works with `pg`, `mysql2`, and similar drivers.
- Use native UUID types where the database supports them, and a JSON column for `cause`.
- Provide DDL snippets for `error_log`.

### 5. Redis

- Push JSON entries onto a list (`LPUSH` or `RPUSH`) with optional `LTRIM` to cap length.
- Optional Streams (`XADD`) mode.

### 6. S3 / DigitalOcean Spaces

- Write one object per entry, or batched objects, keyed by date and UUID.
- Accept a minimal `putObject` client, since Spaces uses the S3 API.
- Support a configurable prefix and content type.

### 7. Firebase

- Firestore: add a document to an `error_log` collection.
- Optional Realtime Database support.
- Accept a collection-like structural type.

### 8. Webhook improvements

The base adapter is already shipped. Remaining work:

- Retry with exponential backoff.
- Request timeout.
- Optional batching.
- Optional HMAC signature header.

### 9. AWS CloudWatch Logs

- Use `PutLogEvents` through an injected client.
- Worth it for apps running outside managed AWS runtimes (Lambda and ECS already ship stdout to CloudWatch).
- Scope: one log group/stream per adapter instance; handle sequence tokens and the batch size limit.
- SNS publishing could share the same client pattern later.

### 10. Event Emitter

- Emit each entry as an event on a user-supplied emitter (anything with `emit(name, payload)`).
- Cheap to build and useful for in-process hooks: UI toasts, metrics counters, and test assertions.
- Scope: no dependencies, and it works with Node `EventEmitter`, `EventTarget` wrappers, and mitt-style emitters.

### 11. WebSocket

- Send JSON entries over a caller-owned socket (anything with `send` and `readyState`).
- Lowest priority; keep it thin. The caller owns connect and reconnect.
- Scope: return a descriptive failure if the socket is not open, with no internal buffering in the first version.

## Cross-Cutting Work

- Fill in README Getting Started, Usage, and Examples.
- Document how to write a custom adapter.
- Add a CHANGELOG entry for each adapter release.
- Consider a shared batching/retry wrapper adapter that can sit in front of any sink.
