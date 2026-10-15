# @richardmcquiston01/error-log-adapter

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

A small, dependency-free TypeScript library for routing runtime errors to the sink of your choice. Code against a single `ErrorLogAdapter` interface, then swap between console, webhook, files, databases, queues, object storage, browser storage, or your own custom adapter without changing application code. Adapters never throw: a failing sink is caught and reported through the returned result, so error logging can't take down your app. Extracted from [chat-and-react](https://github.com/RichardMcQuiston01/chat-and-react).

The package imports no database or cloud SDKs. Each adapter takes a tiny structural interface (such as `{ query(sql, params) }`), which the usual client (`pg`, `mysql2`, `node-redis`, the AWS SDK, `firebase-admin`, `supabase-js`, a MongoDB `Collection`) already satisfies, so you bring your own client and version.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 18 or later, Bun, or a browser. Adapters that need `fetch`, `crypto` or the file system use the runtime's built-ins.
- TypeScript 5 or later (optional)

### Installation

```bash
bun add @richardmcquiston01/error-log-adapter
# or: npm install @richardmcquiston01/error-log-adapter
```

### Usage

Every adapter implements `ErrorLogAdapter`. `log` returns a `Promise<ErrorLogResult>` that never rejects. Check `ok` to find out whether the entry was delivered.

```ts
import {
  ConsoleErrorAdapter,
  type ErrorLogAdapter,
  type ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';

const errorLog: ErrorLogAdapter = new ConsoleErrorAdapter({
  prefix: '[my-app]',
});

const result: ErrorLogResult = await errorLog.log({
  code: 'PAYMENT_FAILED',
  message: 'Card was declined by the processor',
  cause: new Error('insufficient_funds'),
  source: 'checkout',
});

if (!result.ok) {
  // The sink was unreachable. `result.error` says why.
}
```

`ErrorLogEntry` is generic over the error code, so each project can restrict codes to its own union:

```ts
type AppErrorCode = 'PAYMENT_FAILED' | 'AUTH_EXPIRED';
const errorLog: ErrorLogAdapter<AppErrorCode> =
  new ConsoleErrorAdapter<AppErrorCode>();
```

Constructor options are checked when the adapter is created and throw a descriptive `RangeError` for a bad value (an invalid table name, a non-positive limit). `log()` itself never throws.

### Adapters

Every adapter takes an optional `prefix` (default `[error-log-adapter]`) that is printed before its failure messages.

| Adapter                             | Sink                                                      | Runs in       | Main options                         |
| ----------------------------------- | --------------------------------------------------------- | ------------- | ------------------------------------ |
| `ConsoleErrorAdapter`               | `console.error`                                           | Anywhere      |                                      |
| `WebhookErrorAdapter(url)`          | HTTP `POST` of the entry as JSON                          | Anywhere      | `headers`                            |
| `MongoDbErrorAdapter(collection)`   | Anything with `insertOne`, such as a MongoDB `Collection` | Node          |                                      |
| `PostgresErrorAdapter(client)`      | A Postgres table, through `pg`                            | Node          | `tableName`, `createTable`           |
| `MySqlErrorAdapter(client)`         | A MySQL / MariaDB table, through `mysql2/promise`         | Node          | `tableName`, `createTable`           |
| `SqliteErrorAdapter(client)`        | A SQLite table, through any driver                        | Node, Bun     | `tableName`, `createTable`           |
| `SupabaseErrorAdapter(client)`      | A Supabase table, through `supabase-js`                   | Anywhere      | `tableName`                          |
| `RedisErrorAdapter(client)`         | A Redis list or stream                                    | Node          | `mode`, `key`, `maxEntries`, `side`  |
| `S3ErrorAdapter(client, bucket)`    | S3, DigitalOcean Spaces, R2, MinIO objects                | Node          | `keyPrefix`, `batch`, `contentType`  |
| `FirestoreErrorAdapter(collection)` | A Firestore collection                                    | Node, browser | `timeoutMs`                          |
| `RealtimeDatabaseErrorAdapter(ref)` | A Realtime Database reference                             | Node, browser | `timeoutMs`                          |
| `FlatFileErrorAdapter(path)`        | One text line per entry                                   | Node, Bun     | `formatLine`, `maxBytes`, `maxFiles` |
| `JsonFileErrorAdapter(path)`        | NDJSON lines or one JSON array                            | Node, Bun     | `mode`, `maxEntries`, `indent`       |
| `IndexedDbErrorAdapter(database)`   | An IndexedDB object store                                 | Browser       | `storeName`                          |
| `WebStorageErrorAdapter(storage)`   | `sessionStorage` or `localStorage`, as one capped array   | Browser       | `key`, `maxEntries`                  |
| `CompositeErrorAdapter([...])`      | Several adapters at once; succeeds only if all succeed    | Anywhere      |                                      |

Every stored record has the same shape: a UUID `id`, `code`, `message`, `timestamp` (ISO 8601), and optional `source` and `cause`. An `Error` cause is stored as `{ name, message, stack }`. `serializeEntry` and `serializeCause` are exported if you build your own sink.

What changes durability or size, by adapter:

- **SQL adapters** (`createTable`): the table is created on first use by default. Set `createTable: false` and run the statements from `buildErrorLogTableDdl('postgres' | 'mysql')` (or `buildCreateErrorLogTableSql()` for SQLite) yourself if the application's database user should not change the schema. Table names are checked to be plain identifiers.
- **Supabase**: create the table once with `buildSupabaseSetupSql()`, which also turns on row level security. Log from a server with the service role key, which bypasses RLS. A browser-held key needs an insert policy: pass `insertRoles` to the same function.
- **S3** (`batch`): with `batch: { batchSize, maxWaitMs }`, entries are buffered and uploaded together as one NDJSON object. `log()` then returns `ok` as soon as the entry is buffered, so call `flush()` before the process exits.
- **Files** (`maxBytes` / `maxFiles`, `maxEntries`): the flat file adapter rotates by size; the JSON file adapter's `array` mode keeps the newest `maxEntries`.
- **Redis and Web Storage** (`maxEntries`): the oldest entries are dropped past the cap.
- **Firebase** (`timeoutMs`): the Firebase SDKs queue writes while offline and their promises can stay pending, so `log()` stops waiting after `timeoutMs` (default 10 seconds).
- **Browser storage**: `sessionStorage` belongs to one tab. `localStorage` is shared by every tab, so two tabs logging at the same instant can overwrite each other's entry. Use `IndexedDbErrorAdapter` when that matters. Create its object store from your `onupgradeneeded` handler with `createErrorLogStore`.

### Examples

Write to files, a database and the console at once:

```ts
import { Pool } from 'pg';
import {
  CompositeErrorAdapter,
  ConsoleErrorAdapter,
  FlatFileErrorAdapter,
  PostgresErrorAdapter,
} from '@richardmcquiston01/error-log-adapter';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const errorLog = new CompositeErrorAdapter([
  new ConsoleErrorAdapter(),
  new FlatFileErrorAdapter('logs/errors.log', { maxBytes: 5_000_000 }),
  new PostgresErrorAdapter(pool, { createTable: false }),
]);
```

Send errors to a webhook and MongoDB:

```ts
import {
  CompositeErrorAdapter,
  MongoDbErrorAdapter,
  WebhookErrorAdapter,
} from '@richardmcquiston01/error-log-adapter';

const errorLog = new CompositeErrorAdapter([
  new WebhookErrorAdapter('https://example.com/errors', {
    headers: { 'X-Api-Key': process.env.ERROR_WEBHOOK_KEY ?? '' },
  }),
  new MongoDbErrorAdapter(db.collection('error_log')),
]);
```

Keep the last 200 errors in the browser:

```ts
import { WebStorageErrorAdapter } from '@richardmcquiston01/error-log-adapter';

const errorLog = new WebStorageErrorAdapter(window.localStorage, {
  maxEntries: 200,
});
```

Upload to a DigitalOcean Space in batches:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { S3ErrorAdapter } from '@richardmcquiston01/error-log-adapter';

const s3 = new S3Client({
  region: 'nyc3',
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  credentials: { accessKeyId, secretAccessKey },
});

const errorLog = new S3ErrorAdapter(s3, 'my-space', {
  keyPrefix: 'logs/app/',
  batch: { batchSize: 50, maxWaitMs: 30_000 },
});

process.on('beforeExit', () => void errorLog.flush());
```

Write your own adapter by implementing the interface. Catch failures and return them rather than throwing:

```ts
import {
  type ErrorLogAdapter,
  type ErrorLogEntry,
  type ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';

class SlackErrorAdapter implements ErrorLogAdapter {
  constructor(private readonly webhookUrl: string) {}

  async log(entry: ErrorLogEntry): Promise<ErrorLogResult> {
    try {
      const response: Response = await fetch(this.webhookUrl, {
        method: 'POST',
        body: JSON.stringify({ text: `${entry.code}: ${entry.message}` }),
      });
      return response.ok
        ? { ok: true }
        : { ok: false, error: `Slack responded with HTTP ${response.status}` };
    } catch (error: unknown) {
      return { ok: false, error: `Could not reach Slack: ${String(error)}` };
    }
  }
}
```

See [ROADMAP.md](./ROADMAP.md) for planned adapters and [CHANGELOG.md](./CHANGELOG.md) for what changed in each release.

### Development

```bash
bun install
bun run lint        # Prettier check
bun run typecheck
bun run test
bun run build
```

Releases are published to npm by the `Publish` GitHub Action when a GitHub release is created. The release tag must match the version in `package.json` (for example `v0.1.0`).

[Back to Top](#table-of-contents)

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)

[Back to Top](#table-of-contents)

## License

Apache 2

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
