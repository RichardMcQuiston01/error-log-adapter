# @richardmcquiston01/error-log-adapter-nats

[NATS](https://nats.io) adapters for [`@richardmcquiston01/error-log-adapter`](../../README.md). Each error is published as a JSON message to a subject, over a connection you create with the [`nats`](https://www.npmjs.com/package/nats) package. This package has no runtime dependencies: `nats` is only needed by your application.

Two adapters, for the two ways NATS delivers messages:

| Adapter                     | Takes                                  | What `ok: true` means                                                                                                                                           |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NatsErrorAdapter`          | a `NatsConnection`                     | The client accepted the message (with `flush: true`, it was written to the server). Core NATS is at most once: only subscribers connected right now receive it. |
| `NatsJetStreamErrorAdapter` | a `JetStreamClient` (`nc.jetstream()`) | The stream stored the message and acknowledged it. Repeats are dropped by entry `id`.                                                                           |

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-nats nats
```

## Usage

```ts
import { connect, headers } from 'nats';
import { NatsJetStreamErrorAdapter } from '@richardmcquiston01/error-log-adapter-nats';

const connection = await connect({ servers: 'nats://localhost:4222' });
const adapter = new NatsJetStreamErrorAdapter(
  connection.jetstream(),
  'app.errors',
  { createHeaders: headers }
);

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

For core NATS, use `new NatsErrorAdapter(connection, 'app.errors')`. The stream for JetStream must already exist and capture the subject (`nats stream add ERRORS --subjects "app.errors"`); a subject no stream captures fails with "no responders".

## What is published

- **Subject:** the one you pass. It must be dot-separated tokens with no spaces or wildcards.
- **Body:** JSON, the serialized entry plus its UUID `id` (`id`, `code`, `message`, `cause`, `source`, `timestamp`).
- **Headers:** `code` and `source` (when set), if you pass `createHeaders` (the `headers` function from `nats`). The JetStream adapter also sends `Nats-Msg-Id` set to the entry's `id`.

## Options

| Option          | Adapter | Default               | Meaning                                                                                         |
| --------------- | ------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `createHeaders` | both    | none                  | Creates an empty headers object; pass `headers` from `nats` to send `code` and `source`.        |
| `flush`         | core    | `false`               | Wait for the connection to flush to the server, so an unreachable server shows in the result.   |
| `timeoutMs`     | both    | `10000`               | How long to wait for the flush or the stream's acknowledgement. `Infinity` waits without limit. |
| `prefix`        | both    | `[error-log-adapter]` | Text printed before failure messages.                                                           |

## Batching and repeats

Both adapters have `logBatch`, so `BatchingErrorAdapter` can wrap them. It checks every entry first and publishes nothing if one is invalid. The core adapter publishes in order and flushes once. The JetStream adapter publishes all entries together and waits for every acknowledgement; if some fail, the error says how many were stored.

JetStream drops a repeat of the same `id` within the stream's duplicate window (two minutes by default), so retrying a batch after a failure does not store entries twice. Core NATS cannot detect repeats.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency. The `...Like` interfaces are checked against `nats` 2.x types in CI.
