# @richardmcquiston01/error-log-adapter-neo4j

A [Neo4j](https://neo4j.com) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md). Each error becomes an `:ErrorLog` node, written with the official [`neo4j-driver`](https://www.npmjs.com/package/neo4j-driver) that you create. This package has no runtime dependencies: the driver is only needed by your application.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-neo4j neo4j-driver
```

## Usage

```ts
import neo4j from 'neo4j-driver';
import { Neo4jErrorAdapter } from '@richardmcquiston01/error-log-adapter-neo4j';

const driver = neo4j.driver(
  'neo4j://localhost:7687',
  neo4j.auth.basic('neo4j', 'password')
);

const adapter = new Neo4jErrorAdapter(driver, { database: 'neo4j' });

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

Writes go through `driver.executeQuery` with write routing, so they reach the cluster leader. An unreachable server, a bad login or a timeout comes back as `ok: false` with the driver's message.

## The node

| Property      | Type       | Holds                                  |
| ------------- | ---------- | -------------------------------------- |
| `id`          | string     | The entry's UUID (unique)              |
| `code`        | string     | `entry.code`                           |
| `message`     | string     | `entry.message`                        |
| `cause`       | string     | The serialized cause, as a JSON string |
| `source`      | string     | `entry.source`                         |
| `occurred_at` | `DateTime` | `entry.timestamp` (indexed)            |
| `created_at`  | `DateTime` | When the node was written              |

On first use the adapter creates a uniqueness constraint on `id` and an index on `occurred_at` (`createSchema: false` turns that off; `buildNeo4jSchemaStatements()` returns the statements for your own setup):

```cypher
CREATE CONSTRAINT `errorlog_id` IF NOT EXISTS FOR (e:`ErrorLog`) REQUIRE e.id IS UNIQUE
CREATE INDEX `errorlog_occurred_at` IF NOT EXISTS FOR (e:`ErrorLog`) ON (e.occurred_at)
```

These work on Neo4j 4.4 and 5. Reading the latest errors:

```cypher
MATCH (e:ErrorLog) RETURN e ORDER BY e.occurred_at DESC LIMIT 50
```

## Options

| Option         | Default               | Meaning                                                          |
| -------------- | --------------------- | ---------------------------------------------------------------- |
| `label`        | `ErrorLog`            | Node label. Letters, digits and `_`, starting with a letter.     |
| `database`     | the server's default  | Database to write to.                                            |
| `createSchema` | `true`                | Create the constraint and index on first use.                    |
| `timeoutMs`    | `10000`               | How long to wait for each write. `Infinity` waits without limit. |
| `prefix`       | `[error-log-adapter]` | Text printed before failure messages.                            |

## Repeats

Writes use `MERGE (e:ErrorLog {id: $id}) ON CREATE SET ...`, so logging the same entry again (same `id`) leaves the existing node as it is and never duplicates. Pass the `id` when retrying.

## Batches

`logBatch` (used by `BatchingErrorAdapter`) writes all entries in one `UNWIND` query, which is a single transaction: either every node is written or none is. Every entry is checked first, and one that cannot be prepared stops the batch before anything is sent.

## What was checked

- Unit tests with a fake driver.
- A compile-time check that the real `neo4j-driver` `Driver` fits the adapter's driver type.
- Every Cypher statement is parsed by Neo4j's own Cypher parser (`@neo4j-cypher/language-support`).
- An opt-in live test (`neo4j-error-adapter.live.test.ts`) ran against real Neo4j 5 and 4.4 servers in Docker: the node's properties, the constraint and index, a repeated `id` not duplicating, a batch, and a failed login coming back as `ok: false`. It is skipped unless `NEO4J_TEST_URL` is set; see the file for how to run it.
- Not tested: clusters (routing), Aura, and any version other than 5 and 4.4.
