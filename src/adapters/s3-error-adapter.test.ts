import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { S3ErrorAdapter } from './s3-error-adapter.js';
import type { S3ClientLike, S3PutObjectInput } from './s3-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'RULE_EVAL_FAILED',
  message: 'bad rule',
  source: 'rules-engine',
  cause: new Error('x'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

function entry(message: string): ErrorLogEntry {
  return { code: 'E', message, timestamp: '2026-01-02T03:04:05.678Z' };
}

type PutObject = ReturnType<typeof vi.fn<[S3PutObjectInput], Promise<unknown>>>;

function fakeClient(): { client: S3ClientLike; putObject: PutObject } {
  const putObject: PutObject = vi.fn().mockResolvedValue({});
  return { client: { putObject }, putObject };
}

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function lines(input: S3PutObjectInput | undefined): Record<string, unknown>[] {
  return (input?.Body ?? '')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('S3ErrorAdapter (one object per entry)', () => {
  it('uploads one JSON object keyed by date and UUID', async () => {
    const { client, putObject } = fakeClient();

    const result = await new S3ErrorAdapter(client, 'my-bucket').log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(putObject).toHaveBeenCalledTimes(1);
    const input = putObject.mock.calls[0]?.[0];
    expect(input?.Bucket).toBe('my-bucket');
    expect(input?.ContentType).toBe('application/json');
    expect(input?.Key).toMatch(
      /^error_log\/2026\/01\/02\/20260102T030405678Z-[0-9a-f-]{36}\.json$/
    );
    const [record] = lines(input);
    expect(record?.['id']).toBe(
      input?.Key.match(/-([0-9a-f-]{36})\.json$/)?.[1]
    );
    expect(record).toMatchObject({
      code: 'RULE_EVAL_FAILED',
      message: 'bad rule',
      source: 'rules-engine',
      timestamp: '2026-01-02T03:04:05.678Z',
      cause: { name: 'Error', message: 'x' },
    });
  });

  it('gives every entry its own key', async () => {
    const { client, putObject } = fakeClient();
    const adapter = new S3ErrorAdapter(client, 'b');

    await adapter.log(ENTRY);
    await adapter.log(ENTRY);

    const keys = putObject.mock.calls.map(([input]) => input.Key);
    expect(new Set(keys).size).toBe(2);
  });

  it.each([
    ['logs/app', 'logs/app/2026/01/02/'],
    ['logs/app/', 'logs/app/2026/01/02/'],
    ['/logs', 'logs/2026/01/02/'],
    ['', '2026/01/02/'],
  ])('normalizes keyPrefix %j', async (keyPrefix, expectedStart) => {
    const { client, putObject } = fakeClient();

    await new S3ErrorAdapter(client, 'b', { keyPrefix }).log(ENTRY);

    expect(putObject.mock.calls[0]?.[0].Key.startsWith(expectedStart)).toBe(
      true
    );
  });

  it('honors a custom content type', async () => {
    const { client, putObject } = fakeClient();

    await new S3ErrorAdapter(client, 'b', { contentType: 'text/plain' }).log(
      ENTRY
    );

    expect(putObject.mock.calls[0]?.[0].ContentType).toBe('text/plain');
  });

  it('returns a failure result naming the bucket if the upload rejects', async () => {
    const { client, putObject } = fakeClient();
    putObject.mockRejectedValue(new Error('AccessDenied: Access Denied'));
    const spy = silenceConsole();

    const result = await new S3ErrorAdapter(client, 'my-bucket', {
      prefix: '[my-app]',
    }).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('bucket "my-bucket"');
    expect(result.error).toContain('AccessDenied');
    expect(spy).toHaveBeenCalledWith(
      '[my-app] S3ErrorAdapter:',
      expect.any(Error)
    );
    spy.mockRestore();
  });

  it('fails without uploading for an invalid timestamp', async () => {
    const { client, putObject } = fakeClient();
    const spy = silenceConsole();
    const adapter = new S3ErrorAdapter(client, 'b');

    const badTime = await adapter.log({ ...ENTRY, timestamp: 'last tuesday' });

    expect(badTime.error).toContain('"last tuesday" is not a valid ISO 8601');
    expect(putObject).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('stores an entry whose cause is circular, marking the loop', async () => {
    const { client, putObject } = fakeClient();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = await new S3ErrorAdapter(client, 'b').log({
      ...ENTRY,
      cause: circular,
    });

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(putObject.mock.calls)).toContain('[Circular]');
  });
});

describe('S3ErrorAdapter (batched)', () => {
  it('buffers entries and uploads one NDJSON object when the batch is full', async () => {
    const { client, putObject } = fakeClient();
    const adapter = new S3ErrorAdapter(client, 'b', {
      batch: { batchSize: 3 },
    });

    expect(await adapter.log(entry('one'))).toEqual({ ok: true });
    expect(await adapter.log(entry('two'))).toEqual({ ok: true });
    expect(putObject).not.toHaveBeenCalled();
    expect(await adapter.log(entry('three'))).toEqual({ ok: true });

    expect(putObject).toHaveBeenCalledTimes(1);
    const input = putObject.mock.calls[0]?.[0];
    expect(input?.ContentType).toBe('application/x-ndjson');
    expect(input?.Key).toMatch(
      /^error_log\/\d{4}\/\d{2}\/\d{2}\/\d{8}T\d{9}Z-[0-9a-f-]{36}\.ndjson$/
    );
    expect(lines(input).map((record) => record['message'])).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('flush() uploads a partial batch, and is a no-op when nothing is buffered', async () => {
    const { client, putObject } = fakeClient();
    const adapter = new S3ErrorAdapter(client, 'b', {
      batch: { batchSize: 10 },
    });

    expect(await adapter.flush()).toEqual({ ok: true });
    expect(putObject).not.toHaveBeenCalled();
    await adapter.log(entry('one'));
    await adapter.log(entry('two'));
    expect(await adapter.flush()).toEqual({ ok: true });
    expect(await adapter.flush()).toEqual({ ok: true });

    expect(putObject).toHaveBeenCalledTimes(1);
    expect(lines(putObject.mock.calls[0]?.[0])).toHaveLength(2);
  });

  it('uploads the buffer after maxWaitMs even if the batch is not full', async () => {
    vi.useFakeTimers();
    const { client, putObject } = fakeClient();
    const adapter = new S3ErrorAdapter(client, 'b', {
      batch: { batchSize: 10, maxWaitMs: 5000 },
    });

    await adapter.log(entry('one'));
    await vi.advanceTimersByTimeAsync(4999);
    expect(putObject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(putObject).toHaveBeenCalledTimes(1);
    expect(lines(putObject.mock.calls[0]?.[0])).toHaveLength(1);
  });

  it('does not upload again from the timer after a full batch already went out', async () => {
    vi.useFakeTimers();
    const { client, putObject } = fakeClient();
    const adapter = new S3ErrorAdapter(client, 'b', {
      batch: { batchSize: 2, maxWaitMs: 1000 },
    });

    await adapter.log(entry('one'));
    await adapter.log(entry('two'));
    await vi.advanceTimersByTimeAsync(5000);

    expect(putObject).toHaveBeenCalledTimes(1);
  });

  it('keeps entries after a failed upload and retries them with the next log call', async () => {
    const { client, putObject } = fakeClient();
    putObject.mockRejectedValueOnce(
      new Error('SlowDown: Please reduce your request rate')
    );
    const spy = silenceConsole();
    const adapter = new S3ErrorAdapter(client, 'b', {
      batch: { batchSize: 2 },
    });

    await adapter.log(entry('one'));
    const failed = await adapter.log(entry('two'));
    // The buffer is still over the batch size, so the next entry retries the upload.
    const retried = await adapter.log(entry('three'));
    const nothingLeft = await adapter.flush();

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('SlowDown');
    expect(failed.error).toContain(
      '2 buffered entries were kept for the next flush'
    );
    expect(retried).toEqual({ ok: true });
    expect(nothingLeft).toEqual({ ok: true });
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(
      lines(putObject.mock.calls[1]?.[0]).map((record) => record['message'])
    ).toEqual(['one', 'two', 'three']);
    spy.mockRestore();
  });

  it('retries a failed flush() on the next flush()', async () => {
    const { client, putObject } = fakeClient();
    putObject.mockRejectedValueOnce(new Error('offline'));
    const spy = silenceConsole();
    const adapter = new S3ErrorAdapter(client, 'b', {
      batch: { batchSize: 10 },
    });

    await adapter.log(entry('one'));
    const failed = await adapter.flush();
    const retried = await adapter.flush();

    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('1 buffered entry was kept');
    expect(retried).toEqual({ ok: true });
    expect(
      lines(putObject.mock.calls[1]?.[0]).map((record) => record['message'])
    ).toEqual(['one']);
    spy.mockRestore();
  });

  it('does not lose entries logged while an upload is in flight', async () => {
    const { client, putObject } = fakeClient();
    let release: () => void = () => {};
    putObject.mockImplementationOnce(
      () => new Promise<unknown>((resolve) => (release = () => resolve({})))
    );
    const adapter = new S3ErrorAdapter(client, 'b', {
      batch: { batchSize: 2 },
    });

    await adapter.log(entry('one'));
    const second = adapter.log(entry('two'));
    await vi.waitFor(() => expect(putObject).toHaveBeenCalledTimes(1));
    // The first upload now holds a snapshot of [one, two] and is still running.
    const third = adapter.log(entry('three'));
    release();
    await Promise.all([second, third]);
    await adapter.flush();

    expect(putObject).toHaveBeenCalledTimes(2);
    expect(
      lines(putObject.mock.calls[0]?.[0]).map((record) => record['message'])
    ).toEqual(['one', 'two']);
    expect(
      lines(putObject.mock.calls[1]?.[0]).map((record) => record['message'])
    ).toEqual(['three']);
  });

  it('drops the oldest buffered entries once uploads keep failing', async () => {
    const { client, putObject } = fakeClient();
    putObject.mockRejectedValue(new Error('offline'));
    const spy = silenceConsole();
    const adapter = new S3ErrorAdapter(client, 'b', {
      batch: { batchSize: 2 },
    });

    for (let index = 0; index < 22; index += 1) {
      await adapter.log(entry(`m${index}`));
    }
    putObject.mockResolvedValue({});
    await adapter.flush();

    const messages = lines(putObject.mock.calls.at(-1)?.[0]).map(
      (record) => record['message']
    );
    expect(messages).toHaveLength(20);
    expect(messages[0]).toBe('m2');
    expect(messages.at(-1)).toBe('m21');
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('dropped the 1 oldest buffered entries')
    );
    spy.mockRestore();
  });
});

describe('S3ErrorAdapter options', () => {
  const { client } = fakeClient();

  it('rejects an empty bucket', () => {
    expect(() => new S3ErrorAdapter(client, '')).toThrowError(
      /bucket must not be empty/
    );
  });

  it.each([0, -1, 1.5])('rejects batchSize of %s', (batchSize: number) => {
    expect(
      () => new S3ErrorAdapter(client, 'b', { batch: { batchSize } })
    ).toThrowError(/batch.batchSize must be a positive integer/);
  });

  it.each([0, -5, Number.NaN])(
    'rejects maxWaitMs of %s',
    (maxWaitMs: number) => {
      expect(
        () =>
          new S3ErrorAdapter(client, 'b', {
            batch: { batchSize: 2, maxWaitMs },
          })
      ).toThrowError(/batch.maxWaitMs must be a positive number/);
    }
  );
});
