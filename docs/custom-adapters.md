# Writing a custom adapter

An adapter is any object with a `log` method. If the sink you need is not built in, a few dozen lines are enough, and your adapter then works everywhere the built-in ones do: in a `CompositeErrorAdapter`, behind a `BatchingErrorAdapter`, and anywhere your code takes an `ErrorLogAdapter`.

## The contract

```ts
interface ErrorLogAdapter<TCode extends string = string> {
  log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult>;
}

interface ErrorLogResult {
  ok: boolean;
  error?: string; // say what went wrong when ok is false
}
```

The rules that make an adapter safe to drop into an error path:

1. **Never throw or reject from `log`.** Catch everything and return `{ ok: false, error }`. Error logging runs while something is already wrong, so it must not add a second failure. (`CompositeErrorAdapter` guards against a misbehaving adapter, but do not rely on it.)
2. **Make errors descriptive.** Name the adapter and what it was doing: `Slack responded with HTTP 429`, not `failed`. The message is what someone reads at 3 a.m.
3. **Do not hang.** A sink that never answers would hold up every caller that awaits you. Put a timeout on the call (see below).
4. **Leave the entry alone.** Do not mutate what you are given; other adapters in a composite see the same object.
5. **Fill in what is optional.** `timestamp` may be missing, and `id` is an optional UUID.

Throwing is allowed in exactly one place: the **constructor**, for options that can never work (an empty table name, a negative timeout). That is a programming mistake you want to see immediately, so throw a descriptive `RangeError`. The built-in adapters do the same.

## A first adapter

This posts each error to a Slack incoming webhook:

```ts
import {
  serializeEntry,
  type ErrorLogAdapter,
  type ErrorLogEntry,
  type ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';

export class SlackErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  constructor(
    private readonly webhookUrl: string,
    private readonly timeoutMs: number = 10_000
  ) {
    if (!webhookUrl.startsWith('https://')) {
      throw new RangeError(
        'SlackErrorAdapter: the webhook URL must start with https://.'
      );
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record = serializeEntry(entry);
      const response: Response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `*${record.code}* (${record.source ?? 'unknown'}): ${record.message}`,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return {
          ok: false,
          error: `SlackErrorAdapter failed: Slack responded with HTTP ${response.status}`,
        };
      }
      return { ok: true };
    } catch (error: unknown) {
      console.error('[error-log-adapter] SlackErrorAdapter:', error);
      return {
        ok: false,
        error: `SlackErrorAdapter failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
```

What it does right, and why:

- **`<TCode extends string = string>`** lets callers narrow `entry.code` to their own union of error codes, just like the built-in adapters.
- **`serializeEntry`** (exported) turns an entry into a plain JSON-safe object: it fills in `timestamp`, and it converts `cause` (an `Error`, a nested chain of causes, an `AggregateError`, a circular object, a `BigInt`...) into something `JSON.stringify` accepts. Raw `JSON.stringify(entry)` throws on circular structures and drops `Error` fields, which is how error loggers end up logging nothing.
- **`AbortSignal.timeout`** cancels the request instead of leaving it open.
- **The catch block reports twice**: to `console.error`, because a failing logger should still leave a trace, and in the returned result for the caller.

## Wrapping a client instead of a URL

Most of the built-in adapters take a **client you create** (a database driver, an AWS client, a socket) rather than connection details. That keeps the library dependency-free and lets you configure the client however you like. Describe only what you use with a small structural interface:

```ts
import {
  serializeEntry,
  type ErrorLogAdapter,
  type ErrorLogEntry,
  type ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';

/** The one method of a queue client this adapter needs. */
export interface QueueClientLike {
  send(queueName: string, body: string): Promise<unknown>;
}

export class QueueErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  constructor(
    private readonly client: QueueClientLike,
    private readonly queueName: string
  ) {
    if (queueName === '') {
      throw new RangeError('QueueErrorAdapter: queueName must not be empty.');
    }
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      await this.client.send(
        this.queueName,
        JSON.stringify(serializeEntry(entry))
      );
      return { ok: true };
    } catch (error: unknown) {
      console.error('[error-log-adapter] QueueErrorAdapter:', error);
      return {
        ok: false,
        error: `QueueErrorAdapter failed to send to "${this.queueName}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
```

Any real client with a compatible `send` method fits, and so does a three-line fake in your tests.

## Timeouts for clients that cannot be cancelled

`fetch` can be aborted, but most database drivers cannot. For those, stop _waiting_ rather than stop the call:

```ts
function withDeadline<T>(
  start: () => Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    start().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
```

Then `await withDeadline(() => this.client.send(...), 10_000, 'the queue did not respond within 10000 ms')` inside your `try`. Say in the message that the write **may still complete** afterwards, as the built-in adapters do: the caller needs to know a retry could store the entry twice.

## Entry ids and safe retries

`entry.id` is an optional UUID. Without one, every `log` call is a new record. If the caller supplies one, it means "this is the same entry as before", and a sink that can tell should store it once:

- **Validate it.** If `entry.id` is set and is not a UUID, return `{ ok: false, error }` instead of storing something that cannot be matched later. Compare case-insensitively and lower-case it.
- **Use it as the record key** where the sink has one (a primary key, a document id, an object key), so a repeat overwrites or is skipped.
- **If the sink cannot dedupe**, store the id inside the record anyway so it can be deduplicated when read, and say in your documentation that repeats are not detected.
- **Without an `id`**, generate one with `crypto.randomUUID()`.

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entryId(entry: ErrorLogEntry): string {
  if (entry.id === undefined) {
    return crypto.randomUUID();
  }
  if (!UUID.test(entry.id)) {
    throw new RangeError(
      `entry.id must be a UUID such as one from crypto.randomUUID(), received ${JSON.stringify(entry.id)}`
    );
  }
  return entry.id.toLowerCase();
}
```

Call it inside your `try`, so the `RangeError` becomes an `ok: false` result. (`crypto.randomUUID` is unavailable on plain-`http://` browser pages; fall back to `crypto.getRandomValues` if your adapter runs there.)

## Adapters that buffer

If your adapter queues entries and sends them later, two conventions keep it consistent with `S3ErrorAdapter`, `CloudWatchLogsErrorAdapter` and `BatchingErrorAdapter`:

- Expose **`flush(): Promise<ErrorLogResult>`** that sends what is waiting, so callers can drain it before the process exits.
- **Document that `ok: true` means queued, not stored**, and bound the buffer (drop the oldest entries when it is full, and report that) so a dead sink cannot grow memory without limit.

Do not buffer unless you have to. `BatchingErrorAdapter` can put a queue, batching and retries in front of _any_ adapter, including yours, which keeps your adapter small:

```ts
const errorLog = new BatchingErrorAdapter(new SlackErrorAdapter(url), {
  batchSize: 10,
  maxWaitMs: 2000,
});
```

If your sink can take several entries in one call, add a **`logBatch(entries)`** method with the same return type (the `BatchCapableAdapter` interface). `BatchingErrorAdapter` then sends each batch in one call. The whole batch succeeds or fails together.

## Testing

A fake client is all you need, and it lets you check the failure paths, which matter more than the happy one:

```ts
import { describe, expect, it, vi } from 'vitest';

describe('QueueErrorAdapter', () => {
  it('sends the serialized entry', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await new QueueErrorAdapter({ send }, 'errors').log({
      code: 'E',
      message: 'boom',
      cause: new Error('why'),
    });

    expect(result).toEqual({ ok: true });
    const body = JSON.parse(send.mock.calls[0][1]);
    expect(body).toMatchObject({ code: 'E', message: 'boom' });
    expect(body.cause).toMatchObject({ name: 'Error', message: 'why' });
  });

  it('returns a failure instead of throwing when the client fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error('connection reset'));

    const result = await new QueueErrorAdapter({ send }, 'errors').log({
      code: 'E',
      message: 'boom',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('connection reset');
  });
});
```

Worth a test each: a client that rejects, a client that **throws synchronously**, a client that never answers (with fake timers, `vi.useFakeTimers()`), an invalid `id`, a `cause` that is circular, and a constructor given bad options.

## Checklist

- [ ] `log` never throws or rejects; everything is inside `try`/`catch`.
- [ ] Failures return `{ ok: false, error }` with the adapter's name and what it was doing.
- [ ] Failures are also written to `console.error`.
- [ ] The call has a timeout, and the message says the write may still finish.
- [ ] `serializeEntry` is used for anything that goes over the wire or into storage.
- [ ] `entry.id` is validated and, where the sink allows, used to avoid duplicates.
- [ ] The class is generic in `TCode` and implements `ErrorLogAdapter<TCode>`.
- [ ] Options that can never work throw a descriptive `RangeError` from the constructor.
- [ ] Anything buffered has a bounded buffer, a `flush()`, and documentation that `ok` means queued.
