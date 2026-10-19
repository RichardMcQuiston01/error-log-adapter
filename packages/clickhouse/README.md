# @richardmcquiston01/error-log-adapter-clickhouse

A [ClickHouse](https://clickhouse.com) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md). Each error becomes a row in an `error_log` table, written with the official [`@clickhouse/client`](https://www.npmjs.com/package/@clickhouse/client) client that you create. This package has no runtime dependencies: the client is only needed by your application.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-clickhouse @clickhouse/client
```

## Usage

```ts
import { createClient } from '@clickhouse/client';
import { ClickHouseErrorAdapter } from '@richardmcquiston01/error-log-adapter-clickhouse';

const client = createClient({ url: 'http://localhost:8123' });
const adapter = new ClickHouseErrorAdapter(client, { ttlDays: 90 });

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

## The table

Created on first use (`createTable: false` turns that off; `buildClickHouseTableDdl()` returns the statement for your own migration):

| Column        | Type                   | Holds                                               |
| ------------- | ---------------------- | --------------------------------------------------- |
| `id`          | `UUID`                 | The entry's UUID                                    |
| `code`        | `String`               | `entry.code`                                        |
| `message`     | `String`               | `entry.message`                                     |
| `cause`       | `Nullable(String)`     | The serialized cause, as a JSON string              |
| `source`      | `Nullable(String)`     | `entry.source`                                      |
| `occurred_at` | `DateTime64(3, 'UTC')` | `entry.timestamp`                                   |
| `created_at`  | `DateTime64(3, 'UTC')` | When ClickHouse stored the row (default `now64(3)`) |

The engine is `ReplacingMergeTree(created_at)`, partitioned by month and ordered by `(occurred_at, id)`. `ttlDays` adds a `TTL` that deletes rows that many days after `occurred_at`.

## Options

| Option               | Default                                         | Meaning                                                                                                                                                     |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tableName`          | `error_log`                                     | Letters, digits and `_` only.                                                                                                                               |
| `database`           | the client's database                           | Same rules as `tableName`.                                                                                                                                  |
| `ttlDays`            | none (keep forever)                             | Delete rows this many days after `occurred_at`.                                                                                                             |
| `createTable`        | `true`                                          | Create the table on first use.                                                                                                                              |
| `clickhouseSettings` | `{ async_insert: 1, wait_for_async_insert: 1 }` | Settings sent with each insert. The default lets the server batch small inserts while `log` still waits until stored. `{}` sends plain synchronous inserts. |
| `timeoutMs`          | `10000`                                         | How long to wait for each request. `Infinity` waits without limit.                                                                                          |
| `prefix`             | `[error-log-adapter]`                           | Text printed before failure messages.                                                                                                                       |

## Batching

ClickHouse prefers a few large inserts to many small ones. For heavy traffic put a `BatchingErrorAdapter` in front: this adapter's `logBatch` writes a whole batch in a single insert, and ClickHouse stores all of its rows or none. `logBatch` checks every entry first and writes nothing if one is invalid.

## Repeats

ClickHouse has no unique keys, so a repeated entry is not rejected. A row with the same `occurred_at` and `id` is collapsed by the table engine when parts merge (the later write wins), and `SELECT ... FINAL` shows the collapsed result immediately. For a retry to collapse, pass the same `id` **and** the same `timestamp`; a retry without a `timestamp` gets a new time and is stored as a second row.

## Checked against a real engine

The generated `CREATE TABLE` statement and the row shape were run against a real ClickHouse engine (embedded, through chDB): the table is created, `JSONEachRow` inserts with `null` cause and source are accepted, `created_at` fills in, a repeat with the same `id` and `occurred_at` collapses, and the TTL variant is accepted. The adapter has not been run against a ClickHouse server over HTTP; a compile-time test checks that the real `@clickhouse/client` types fit `ClickHouseClientLike`.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency.
