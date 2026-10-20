# @richardmcquiston01/error-log-adapter-rabbitmq

A RabbitMQ (AMQP 0-9-1) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md). Each error is published as a JSON message through an [amqplib](https://www.npmjs.com/package/amqplib) channel that you create. The package has no runtime dependencies: `amqplib` is only needed by your application.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-rabbitmq amqplib
```

## Usage

```ts
import amqp from 'amqplib';
import { RabbitMqErrorAdapter } from '@richardmcquiston01/error-log-adapter-rabbitmq';

const connection = await amqp.connect('amqp://localhost');
const channel = await connection.createConfirmChannel();
await channel.assertQueue('error_log', { durable: true });

const adapter = new RabbitMqErrorAdapter(channel, { confirm: true });

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

Declare the queue or exchange yourself; the adapter only publishes. Publishing to an exchange that does not exist makes the broker close the channel, and later `log` calls then report failures.

## What is published

- **Body:** JSON, the serialized entry plus its UUID `id` (`id`, `code`, `message`, `cause`, `source`, `timestamp`).
- **Properties:** `messageId` is the entry's UUID, `type` is the `code`, `timestamp` is the entry time in seconds, `contentType` is `application/json`, and `persistent` is on.
- **Headers:** `code` and `source` (when set), so a headers exchange can route on them. `headers: false` turns it off.

## Options

| Option       | Default               | Meaning                                                                                                                                                |
| ------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exchange`   | `''`                  | Exchange to publish to. The default exchange delivers to the queue named by `routingKey`.                                                              |
| `routingKey` | `'error_log'`         | Routing key, or the queue name on the default exchange.                                                                                                |
| `confirm`    | `false`               | Wait for the broker to confirm each message. **Needs a `ConfirmChannel`**: on a plain `Channel` the confirmation never comes and every call times out. |
| `persistent` | `true`                | Delivery mode 2.                                                                                                                                       |
| `headers`    | `true`                | Send `code` and `source` as headers.                                                                                                                   |
| `timeoutMs`  | `10000`               | With `confirm`, how long to wait for the broker. `Infinity` waits without limit.                                                                       |
| `prefix`     | `[error-log-adapter]` | Text printed before failure messages.                                                                                                                  |

Without `confirm`, `ok: true` means the message was handed to the client's send buffer, not that the broker has it.

## Batching and repeats

`logBatch` publishes entries in order, so `BatchingErrorAdapter` can wrap this adapter. It checks every entry first, stops at the first failure and says how many entries had already gone out.

RabbitMQ does not detect repeats. Logging the same entry (same `id`) twice delivers it twice; consumers that need exactly-once handling should de-duplicate on `message-id`.

## What was checked

- Unit tests with fake channels, and a compile-time check that the real `amqplib` channel types fit the adapter's channel type.
- An opt-in live test (`rabbitmq-error-adapter.live.test.ts`) ran against a real RabbitMQ 3.13 broker in Docker: the body, `messageId`, `type`, `contentType`, persistent delivery mode, timestamp and `code`/`source` headers on a confirmed message; `headers: false`; delivery on a plain channel without `confirm`; a batch in order; a repeated entry arriving twice (as described above); routing through a headers exchange on the `code` header; and a missing exchange and a closed connection coming back as `ok: false`. It is skipped unless `RABBITMQ_TEST_URL` is set; see the file for how to run it.
- Not tested: RabbitMQ 4 (its Docker image would not start in the environment used), clusters, TLS, quorum queues, and publisher confirms under load.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency.
