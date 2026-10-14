# CHANGELOG

## Unreleased

- `FlatFileErrorAdapter` appends one text line per entry to a file (Node and Bun). Options: custom `formatLine`, size-based rotation (`maxBytes` / `maxFiles`), and automatic parent folder creation. Writes are queued so concurrent calls stay in order.
- `WebStorageErrorAdapter` for `sessionStorage` and `localStorage`. Entries are kept as a JSON array under one key, capped at `maxEntries` (default 100). When the store is full, the oldest entries are dropped until the new one fits.
- `SqliteErrorAdapter` for any SQLite driver through a one-method `run(sql, params)` client, plus `buildCreateErrorLogTableSql` for running your own migration. Rows go into a singular `error_log` table with a UUID `id`, snake_case columns, and `occurred_at` / `created_at` timestamps.
- `IndexedDbErrorAdapter` for browser storage, plus a `createErrorLogStore` helper for `onupgradeneeded`. Records get a UUID `id` key and a `timestamp` index.

## 0.1.0

- Initial release, extracted from [chat-and-react](https://github.com/RichardMcQuiston01/chat-and-react).
- `ErrorLogAdapter` interface with generic error codes. `log` returns a `Promise<ErrorLogResult>` that never rejects.
- `ConsoleErrorAdapter`, `WebhookErrorAdapter`, `MongoDbErrorAdapter`, and `CompositeErrorAdapter`.
- Configurable log prefix; `Error` causes are serialized so they survive JSON.
