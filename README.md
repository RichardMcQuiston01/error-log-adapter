# @richardmcquiston01/error-log-adapter

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

A small, dependency-free TypeScript library for routing runtime errors to the sink of your choice. Code against a single ErrorLogAdapter interface, then swap between console, webhook, MongoDB, or your own custom adapter without changing application code. Adapters never throw: a failing sink is caught and reported through the returned result, so error logging can’t take down your app. Extracted from [chat-and-react](https://github.com/RichardMcQuiston01/chat-and-react).

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 18 or later (uses the built-in `fetch`), or any runtime with a global `fetch`
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

Available adapters:

| Adapter                 | Sink                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `ConsoleErrorAdapter`   | `console.error`                                                                    |
| `WebhookErrorAdapter`   | HTTP `POST` of the entry as JSON                                                   |
| `MongoDbErrorAdapter`   | Any object with `insertOne`, such as a MongoDB `Collection` (no driver dependency) |
| `CompositeErrorAdapter` | Several adapters at once; succeeds only if all succeed                             |

`ErrorLogEntry` is generic over the error code, so each project can restrict codes to its own union:

```ts
type AppErrorCode = 'PAYMENT_FAILED' | 'AUTH_EXPIRED';
const errorLog: ErrorLogAdapter<AppErrorCode> =
  new ConsoleErrorAdapter<AppErrorCode>();
```

### Examples

Send errors to a webhook and a database, and keep a console copy:

```ts
import {
  CompositeErrorAdapter,
  ConsoleErrorAdapter,
  MongoDbErrorAdapter,
  WebhookErrorAdapter,
} from '@richardmcquiston01/error-log-adapter';

const errorLog = new CompositeErrorAdapter([
  new ConsoleErrorAdapter(),
  new WebhookErrorAdapter('https://example.com/errors', {
    headers: { 'X-Api-Key': process.env.ERROR_WEBHOOK_KEY ?? '' },
  }),
  new MongoDbErrorAdapter(db.collection('error_log')),
]);
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
