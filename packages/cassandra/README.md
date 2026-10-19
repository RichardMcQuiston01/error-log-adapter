# @richardmcquiston01/error-log-adapter-cassandra

An [Apache Cassandra](https://cassandra.apache.org) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md) (it also suits ScyllaDB). Each error becomes a row in an `error_log` table, written with the DataStax [`cassandra-driver`](https://www.npmjs.com/package/cassandra-driver) client that you create. This package has no runtime dependencies: the driver is only needed by your application.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-cassandra cassandra-driver
```

## Usage

```ts
import { Client, types } from 'cassandra-driver';
import { CassandraErrorAdapter } from '@richardmcquiston01/error-log-adapter-cassandra';

const client = new Client({
  contactPoints: ['127.0.0.1'],
  localDataCenter: 'datacenter1',
  keyspace: 'logs',
});
await client.connect();

const adapter = new CassandraErrorAdapter(client, {
  ttlSeconds: 90 * 24 * 60 * 60,
  consistency: types.consistencies.localQuorum,
});

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

The keyspace must already exist (`CREATE KEYSPACE logs WITH replication = {...}`); the adapter creates the table, not the keyspace. A missing keyspace, an unreachable cluster or a timeout comes back as `ok: false` with the driver's message.

## The table

Created on first use (`createTable: false` turns that off; `buildCassandraTableDdl()` returns the statement for your own migration):

| Column        | Type        | Holds                                        |
| ------------- | ----------- | -------------------------------------------- |
| `bucket`      | `text`      | Partition key: the UTC day of `occurred_at`  |
| `occurred_at` | `timestamp` | `entry.timestamp` (clustering, newest first) |
| `id`          | `uuid`      | The entry's UUID (clustering)                |
| `code`        | `text`      | `entry.code`                                 |
| `message`     | `text`      | `entry.message`                              |
| `cause`       | `text`      | The serialized cause, as a JSON string       |
| `source`      | `text`      | `entry.source`                               |
| `created_at`  | `timestamp` | When the row was written                     |

`PRIMARY KEY ((bucket), occurred_at, id)` with `CLUSTERING ORDER BY (occurred_at DESC, id ASC)`. Partitioning by time keeps partitions from growing without bound and makes "the latest errors" a read of one partition:

```cql
SELECT * FROM error_log WHERE bucket = '2026-10-19' LIMIT 50;
```

`bucket` (`hour`, `day` or `month`, default `day`) sets the partition size: use `hour` for very busy services, `month` for quiet ones. To read a longer range, query each bucket in it. `cause` and `source` are left out of the insert when the entry has none, so no tombstones are written.

## Options

| Option         | Default               | Meaning                                                                    |
| -------------- | --------------------- | -------------------------------------------------------------------------- |
| `tableName`    | `error_log`           | Letters, digits and `_`, starting with a letter.                           |
| `keyspace`     | the client's keyspace | Same rules as `tableName`.                                                 |
| `bucket`       | `day`                 | Partition size: `hour`, `day` or `month` (UTC).                            |
| `ttlSeconds`   | none (keep forever)   | Rows are deleted this long after they are written (`USING TTL`).           |
| `consistency`  | the client's          | Consistency level for every write, e.g. `types.consistencies.localQuorum`. |
| `maxBatchSize` | `20`                  | Most rows in one batch statement in `logBatch`.                            |
| `createTable`  | `true`                | Create the table on first use.                                             |
| `timeoutMs`    | `10000`               | How long to wait for each request. `Infinity` waits without limit.         |
| `prefix`       | `[error-log-adapter]` | Text printed before failure messages.                                      |

## Repeats

A Cassandra insert is an upsert. Logging the same entry again (same `id` **and** same `timestamp`) rewrites the same row with the same data, so a retry never duplicates; only `created_at` changes. A retry without a fixed `timestamp` gets a new time, so it lands in a different row. Pass the `id` and the `timestamp` together when retrying.

## Batching

`logBatch` groups the rows by partition and sends each group as unlogged batches of up to `maxBatchSize` rows, all at once. Rows of one partition in one batch are applied together; batches themselves are not atomic with each other. `logBatch` checks every entry first and writes nothing if one is invalid. If some batches fail, the error says how many rows were stored, and trying the whole batch again is safe because of the upsert. Use it through `BatchingErrorAdapter` for heavy traffic.

## What was checked

- The unit tests use a fake client and check the exact statements and values: the table statement, the inserts (with and without `cause`/`source`, with a TTL), partition grouping, batch sizes and the error reports. A compile-time check fits the real `cassandra-driver` `Client` type to `CassandraClientLike`.
- The values the adapter binds were run through the driver's own encoder for the column types (a UUID string as `uuid`, a `Date` as `timestamp`, strings as `text`), and a malformed UUID is rejected by it.
- **It has not been run against a Cassandra (or ScyllaDB) server.** No server was available when this was written, so the CQL statements have not been executed by a real node.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency. Written against `cassandra-driver` 4.
