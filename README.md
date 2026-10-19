# @richardmcquiston01/error-log-adapter

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [Stability](#stability) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

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

| Adapter                                             | Sink                                                           | Runs in       | Main options                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------- |
| `ConsoleErrorAdapter`                               | `console.error`                                                | Anywhere      |                                                                     |
| `WebhookErrorAdapter(url)`                          | HTTP `POST` of the entry as JSON                               | Anywhere      | `headers`, `timeoutMs`, `retries`, `signingSecret`, `allowInsecure` |
| `MongoDbErrorAdapter(collection)`                   | Anything with `insertOne`, such as a MongoDB `Collection`      | Node          | `timeoutMs`                                                         |
| `PostgresErrorAdapter(client)`                      | A Postgres table, through `pg`                                 | Node          | `tableName`, `createTable`, `timeoutMs`                             |
| `MySqlErrorAdapter(client)`                         | A MySQL / MariaDB table, through `mysql2/promise`              | Node          | `tableName`, `createTable`, `timeoutMs`                             |
| `SqliteErrorAdapter(client)`                        | A SQLite table, through any driver                             | Node, Bun     | `tableName`, `createTable`, `timeoutMs`                             |
| `SupabaseErrorAdapter(client)`                      | A Supabase table, through `supabase-js`                        | Anywhere      | `tableName`, `timeoutMs`                                            |
| `RedisErrorAdapter(client)`                         | A Redis list or stream                                         | Node          | `mode`, `key`, `maxEntries`, `side`, `timeoutMs`                    |
| `S3ErrorAdapter(client, bucket)`                    | S3, DigitalOcean Spaces, R2, MinIO objects                     | Node          | `keyPrefix`, `batch`, `contentType`, `timeoutMs`                    |
| `FirestoreErrorAdapter(collection)`                 | A Firestore collection                                         | Node, browser | `timeoutMs`, `expireAfterMs`                                        |
| `RealtimeDatabaseErrorAdapter(ref)`                 | A Realtime Database reference                                  | Node, browser | `timeoutMs`                                                         |
| `FlatFileErrorAdapter(path)`                        | One text line per entry                                        | Node, Bun     | `formatLine`, `maxBytes`, `maxFiles`                                |
| `JsonFileErrorAdapter(path)`                        | NDJSON lines or one JSON array                                 | Node, Bun     | `mode`, `maxBytes`, `maxFiles`, `maxEntries`, `indent`              |
| `IndexedDbErrorAdapter(database)`                   | An IndexedDB object store                                      | Browser       | `storeName`, `timeoutMs`                                            |
| `WebStorageErrorAdapter(storage)`                   | `sessionStorage` or `localStorage`, as one capped array        | Browser       | `key`, `maxEntries`, `locks`                                        |
| `EventEmitterErrorAdapter(emitter)`                 | An event on an emitter you own (in-process hooks)              | Anywhere      | `eventName`, `requireListener`                                      |
| `WebSocketErrorAdapter(socket)`                     | One JSON message over a socket you own                         | Anywhere      | (none)                                                              |
| `CloudWatchLogsErrorAdapter(client, group, stream)` | AWS CloudWatch Logs events                                     | Node          | `batch`, `createMissing`, `timeoutMs`                               |
| `SnsErrorAdapter(client, topicArn)`                 | An Amazon SNS topic: email, SMS, SQS, Lambda, HTTPS fan-out    | Node          | `attributes`, `subject`, `messageGroupId`, `logBatch`, `timeoutMs`  |
| `BatchingErrorAdapter(adapter)`                     | A queue in front of any adapter: batches, retries with backoff | Anywhere      | `batchSize`, `maxWaitMs`, `retries`, `maxBuffered`, `onDrop`        |
| `CompositeErrorAdapter([...])`                      | Several adapters at once; succeeds only if all succeed         | Anywhere      | `timeoutMs`                                                         |

Every stored record has the same shape: a UUID `id`, `code`, `message`, `timestamp` (ISO 8601), and optional `source` and `cause`. An `Error` cause is stored as `{ name, message, stack }`. `serializeEntry` and `serializeCause` are exported if you build your own sink.

What changes durability or size, by adapter:

- **SQL adapters** (`createTable`): the table is created on first use by default. Set `createTable: false` and run the statements from `buildErrorLogTableDdl('postgres' | 'mysql')` (or `buildCreateErrorLogTableSql()` for SQLite) yourself if the application's database user should not change the schema. Table names are checked to be plain identifiers. A MySQL table made by 0.4.0 or earlier has `VARCHAR(255)` columns for `code` and `source`; run the statement from `buildMySqlWidenColumnsSql()` once to widen them.
- **Supabase**: create the table once with `buildSupabaseSetupSql()`, which also turns on row level security. Log from a server with the service role key, which bypasses RLS and must never reach a browser. A browser-held key needs an insert policy: pass `insertRoles: ['authenticated']` to the same function. The policy limits the size of each field but cannot tie a row to a user, so a holder of that key can still add entries of their own. Listing `anon` or `public` throws unless you also pass `allowPublicInsert: true`, because the anon key is public.
- **S3** (`batch`): with `batch: { batchSize, maxWaitMs }`, entries are buffered and uploaded together as one NDJSON object. `log()` then returns `ok` as soon as the entry is buffered, so call `flush()` before the process exits.
- **Files** (`maxBytes` / `maxFiles`, `maxEntries`): the flat file adapter and the JSON file adapter's `ndjson` mode rotate by size: before a write that would push the file past `maxBytes`, `errors.log` becomes `errors.log.1` (older files shift up, and the one past `maxFiles`, default 3, is deleted). Every file holds whole lines, an entry is never split across files, and a failed rotation is reported to the console but the entry is still written. Rotation assumes one process writes the file. The JSON file adapter's `array` mode instead keeps the newest `maxEntries`, and rejects `maxBytes` / `maxFiles`.
- **Redis and Web Storage** (`maxEntries`): the oldest entries are dropped past the cap.
- **Browser storage**: `sessionStorage` belongs to one tab. `localStorage` is shared by every tab and has no atomic update, so two tabs logging at the same instant can overwrite each other's entry. `WebStorageErrorAdapter` takes a `navigator.locks` lock around each write, which reduces the loss but cannot remove it, since tabs in separate processes can still read a stale copy. Use `IndexedDbErrorAdapter` when every entry matters. Create its object store from your `onupgradeneeded` handler with `createErrorLogStore`. A stored value the adapter cannot read is copied to `<key>.corrupt` before it is replaced.
- **Firestore expiry**: pass `expireAfterMs` (for example `30 * 24 * 60 * 60 * 1000`) and every document gets a Firestore timestamp field, `expire_at` (change the name with `expireField`), set to the entry's `timestamp` plus that time. This only writes the field: Firestore deletes nothing until you enable a TTL policy on it, in the console or with `gcloud firestore fields ttls update expire_at --collection-group=error_log --enable-ttl`. Documents are then removed some time after they expire (typically within a day), and the deletes are billed like any other. The Realtime Database has no TTL feature, so the option is Firestore only.
- **Event emitter**: each entry is emitted as an `error-log` event whose payload is the stored record, for in-process hooks such as a toast, a metrics counter or a test assertion. Listeners run synchronously, so one that throws makes `log()` return `ok: false` with its message. Node's `EventEmitter` and mitt work as they are; a browser `EventTarget` needs a one-line wrapper (shown in the example below). Don't name the event `error` on a Node `EventEmitter`: it throws when nobody listens. Node's `emit` returns `false` when there are no listeners; pass `requireListener: true` to report that as a failure instead of letting the entry vanish.
- **WebSocket**: each entry is sent as one JSON text message (the serialized entry plus its UUID `id`) over a socket you own; the adapter never connects, reconnects or buffers. If the socket's `readyState` is not open (connecting, closing or closed), `log()` returns `ok: false` and says which. `ok: true` means the socket accepted the message, not that the server got it, since a WebSocket has no acknowledgement. Browsers, Node's global `WebSocket`, Deno, Bun and `ws` all fit. Pair it with a durable adapter in a `CompositeErrorAdapter` if entries must survive the socket being down.
- **CloudWatch Logs**: each entry is sent through `PutLogEvents` as a JSON event (the serialized entry plus its UUID `id`) stamped with the entry's time, so Logs Insights can query its fields. Pass an AWS SDK v3 `CloudWatchLogs` client. AWS no longer needs sequence tokens, so none are tracked. If the stream (or group) does not exist, the adapter creates it and tries again once (`createMissing`, on by default; it needs `logs:CreateLogStream` and `logs:CreateLogGroup`, and a group created this way never expires its logs, so set a retention policy). CloudWatch can answer ok and still refuse events older than 14 days or more than 2 hours ahead; that is reported as `ok: false`. An event over 256 KiB is refused before sending. With `batch: { batchSize, maxWaitMs }`, events are buffered and sent together (up to 10,000 events and 1 MiB per request, oldest first), `log()` returns `ok` as soon as the event is buffered, and you should call `flush()` before the process exits. In Lambda and ECS, stdout already reaches CloudWatch; this is for apps running elsewhere.
- **SNS**: each entry is published to a topic as a JSON message (the serialized entry plus its UUID `id`), so one error can fan out to email, SMS, SQS, Lambda and HTTPS subscribers. Pass an AWS SDK v3 `SNS` client. `ok: true` means SNS accepted the message, not that every subscriber got it. The entry's `code` and `source` are also sent as message attributes, so a subscription filter policy such as `{ "code": ["PAYMENT_FAILED"] }` receives only the codes it cares about (`attributes: false` turns that off). The subject is `<code>: <message>` cut to 99 characters with anything outside printable ASCII replaced by `?`, because SNS accepts nothing else (`subject: false` leaves it out). A message over 256 KiB, attributes included, is refused before sending. For a FIFO topic (an ARN ending in `.fifo`) pass `messageGroupId`; the entry's `id` becomes the deduplication id, so logging the same entry again within five minutes is dropped by SNS. A standard topic cannot detect a repeat, so if a call reports a timeout, logging the entry again can deliver it twice. Email and SMS subscribers see raw JSON; for people, subscribe a Lambda or a chat integration instead. `logBatch(entries)` publishes several entries with `PublishBatch`, up to 10 messages and 256 KiB per request, and `BatchingErrorAdapter` uses it automatically when it wraps this adapter, so a batch of 20 is two requests instead of twenty. Every entry is checked before anything is sent, so one that cannot be sent (an invalid `id`, a message over 256 KiB) fails the whole call with nothing published; after that the call stops at the first request that fails and says how many entries were already published, and trying the whole batch again re-sends those, which a standard topic cannot detect (a FIFO topic drops them by `id`). A client without `publishBatch` still works: the entries are published one by one. Put a `BatchingErrorAdapter` in front if a slow publish must not hold up the app.
- **Batching wrapper**: `BatchingErrorAdapter` puts a queue in front of any other adapter. `log()` returns `ok: true` as soon as the entry is queued, so a slow or failing sink never holds up the app, and entries are delivered in order in batches (`batchSize`, default 20, or after `maxWaitMs`, default 5000). A failed delivery is retried with exponential backoff (`retries`, default 3) and then given up on: the entries go to `onDrop` and the console, and `flush()` returns `ok: false` once. Delivery stops at the first failure so a dead sink is not hammered. If the wrapped adapter has a `logBatch` method (the webhook and the SNS adapter do) the batch goes in one call, which for the webhook means one request carrying a JSON array, so the receiver must accept an array; pass `useBatchMethod: false` to keep one request per entry. `ok: true` means _queued_, not stored, and the queue lives in memory: call `flush()` before the process exits, and put a durable adapter beside it in a `CompositeErrorAdapter` if entries must survive a crash. Do not also enable the wrapped adapter's own retries (the webhook's `retries`); they multiply. The buffer holds `maxBuffered` entries (default 1000) and drops the oldest past that.
- **Webhook**: the URL must be `https://` (or `http://localhost`, `127.0.0.1`, `[::1]`) unless you pass `allowInsecure: true`, because entries carry messages and stack traces. Redirects are not followed, since a redirect would turn the `POST` into a body-less `GET` or re-send the entry and your headers to another host; a redirect is reported as `ok: false`. Failure messages contain only the origin, never the path or query, because webhook URLs often hold a secret. Set `retries` to try again after a network error, a timeout, HTTP 408, 425, 429 or 5xx (exponential backoff with jitter from `retryDelayMs`, capped by `maxRetryDelayMs`, honoring `Retry-After`; other 4xx answers are never retried). With `retries` set, every attempt sends the same body including an `id`, so the receiver can drop a repeat. Set `signingSecret` to add `X-Signature-Timestamp` and `X-Signature-256` (`sha256=` + hex HMAC-SHA256 of `<timestamp>.<body>`); the receiver recomputes it and rejects old timestamps.

### When a sink is slow or down

`log()` never rejects, and it does not wait forever either. Every adapter that talks over a network or to a driver takes `timeoutMs` (default `10000`; `Infinity` waits without limit). When it passes, `log()` returns `{ ok: false }` with a message such as `Postgres did not respond within 10000 ms, so the entry may or may not have been stored`. Drivers cannot cancel a call, so the write may still finish afterwards (the webhook is the exception: its request is aborted). `CompositeErrorAdapter` has its own per-adapter `timeoutMs` (default `30000`), so one hung custom adapter cannot hold back the others.

Because of that, a failed call is not proof that nothing was stored. To retry safely, give the entry an `id`:

```ts
const entry = {
  id: crypto.randomUUID(), // a UUID; anything else makes log() return ok: false
  timestamp: new Date().toISOString(),
  code: 'PAYMENT_FAILED',
  message: 'Card was declined by the processor',
};

let result = await errorLog.log(entry);
if (!result.ok) {
  result = await errorLog.log(entry); // same id: a repeat is stored once
}
```

Without an `id`, every call to `log()` gets a new random one, so logging twice stores two records. With one:

| Adapter                                              | A repeat of the same `id`                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Postgres, MySQL, SQLite                              | Stored once (`ON CONFLICT` / `ON DUPLICATE KEY`)                                                                |
| MongoDB, Supabase                                    | Stored once; the duplicate-key error counts as success                                                          |
| Firestore                                            | Overwrites the same document                                                                                    |
| Realtime Database                                    | Overwrites the same key. Needs `child(key).set(value)` on the reference you pass in; without it `log()` says so |
| IndexedDB, Web Storage, JSON file (`array` mode)     | Replaces the earlier record                                                                                     |
| S3                                                   | Overwrites the same object only if the retry also has the same `timestamp` (the key contains both)              |
| Webhook                                              | The `id` is added to the JSON body so the receiver can drop repeats                                             |
| CloudWatch Logs                                      | Cannot detect a repeat (the `id` is in the message, so Logs Insights can `dedup id`)                            |
| SNS                                                  | FIFO topic: dropped within five minutes (the `id` is the deduplication id). Standard topic: cannot detect it    |
| Redis, flat file, JSON file (`ndjson` mode), console | Cannot detect a repeat                                                                                          |

`CompositeErrorAdapter` passes the entry through unchanged, so every sink sees the same `id`.

### What gets stored for a `cause`

`serializeCause` turns any cause into something `JSON.stringify` always accepts, so an unusual cause can never stop an entry from being stored. An `Error` becomes `{ name, message, stack }` plus its own `cause` and, for an `AggregateError`, `errors`, recursively. Circular references become `"[Circular]"`, nesting deeper than 6 levels becomes `"[Truncated]"`, and `BigInt`, `Symbol`, functions and non-finite numbers become strings.

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

Show a toast, count errors, and keep a file copy, all from one `log` call:

```ts
import { EventEmitter } from 'node:events';
import {
  CompositeErrorAdapter,
  EventEmitterErrorAdapter,
  FlatFileErrorAdapter,
} from '@richardmcquiston01/error-log-adapter';

const bus = new EventEmitter();
bus.on('error-log', (record) => showToast(record.message));
bus.on('error-log', (record) => metrics.increment(`errors.${record.code}`));

const errorLog = new CompositeErrorAdapter([
  new EventEmitterErrorAdapter(bus),
  new FlatFileErrorAdapter('logs/errors.log'),
]);
```

In a browser, wrap an `EventTarget`:

```ts
const target = new EventTarget();
const emitter = {
  emit: (name: string, payload: unknown) =>
    target.dispatchEvent(new CustomEvent(name, { detail: payload })),
};
target.addEventListener('error-log', (event) =>
  console.log((event as CustomEvent).detail)
);
const errorLog = new EventEmitterErrorAdapter(emitter);
```

Send errors over a socket you manage, with a file as the fallback while it is down:

```ts
const socket = new WebSocket('wss://logs.example.com/errors');
const errorLog = new CompositeErrorAdapter([
  new WebSocketErrorAdapter(socket),
  new FlatFileErrorAdapter('./errors.log'),
]);
```

Send errors to CloudWatch Logs from an app running outside AWS:

```ts
import { CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchLogsErrorAdapter } from '@richardmcquiston01/error-log-adapter';

const errorLog = new CloudWatchLogsErrorAdapter(
  new CloudWatchLogs({ region: 'us-east-1' }),
  '/my-app/errors',
  `web-${process.pid}`,
  { batch: { batchSize: 100, maxWaitMs: 5000 } }
);
process.on('beforeExit', () => void errorLog.flush());
```

Publish errors to an SNS topic. Each message carries `code` and `source` attributes, so subscribers can filter on them:

```ts
import { SNS } from '@aws-sdk/client-sns';
import { SnsErrorAdapter } from '@richardmcquiston01/error-log-adapter';

const errorLog = new SnsErrorAdapter(
  new SNS({ region: 'us-east-1' }),
  'arn:aws:sns:us-east-1:123456789012:app-errors'
);
await errorLog.log({ code: 'PAYMENT_FAILED', message: 'card declined' });
```

Batch and retry in front of a webhook, so a slow endpoint never holds up the app:

```ts
const errorLog = new BatchingErrorAdapter(
  new WebhookErrorAdapter('https://example.com/errors', {
    signingSecret: process.env.ERROR_WEBHOOK_SECRET,
  }),
  {
    batchSize: 50,
    maxWaitMs: 2000,
    onDrop: (entries, reason) =>
      console.warn(`lost ${entries.length}: ${reason}`),
  }
);
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

The full guide, [docs/custom-adapters.md](./docs/custom-adapters.md), covers the contract, timeouts, entry ids, buffering adapters, testing, and a checklist.

See [ROADMAP.md](./ROADMAP.md) for planned adapters and [CHANGELOG.md](./CHANGELOG.md) for what changed in each release.

### Development

```bash
bun install
bun run lint        # Prettier check
bun run typecheck
bun run test
bun run build
bun run test:live   # opt-in tests against real services, see below
```

`bun run test:live` runs the `*.live.test.ts` files, which are skipped unless their environment variables are set (`bun run test` and CI never touch a real service). Each file starts with a comment that lists its variables and the permissions it needs, and cleans up what it creates:

| Adapter         | Set to enable                     | Runs against                                             |
| --------------- | --------------------------------- | -------------------------------------------------------- |
| S3              | `S3_TEST_BUCKET` (and a key pair) | an S3-compatible bucket                                  |
| CloudWatch Logs | `CLOUDWATCH_TEST_REGION`          | CloudWatch Logs, or LocalStack via an endpoint           |
| SNS             | `SNS_TEST_REGION`                 | SNS and SQS, or LocalStack / moto via an endpoint        |
| Firestore       | `FIRESTORE_TEST_PROJECT_ID`       | Firestore, or the emulator via `FIRESTORE_EMULATOR_HOST` |

Releases are published to npm by the `Publish` GitHub Action when a GitHub release is created. The release tag must match the version in `package.json` (for example `v0.1.0`).

[Back to Top](#table-of-contents)

## Stability

From 1.0.0 the package follows [Semantic Versioning](https://semver.org/): the `ErrorLogAdapter` contract, every adapter, the setup helpers and the `...Like` client types change in a breaking way only in a major version. Anything tagged `@experimental` may change in a minor release. See [Versioning, support and deprecation](docs/versioning-policy.md) and [SECURITY.md](SECURITY.md).

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
