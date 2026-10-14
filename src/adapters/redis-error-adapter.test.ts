import { describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { RedisErrorAdapter } from './redis-error-adapter.js';
import type { RedisClientLike } from './redis-error-adapter.js';

const ENTRY: ErrorLogEntry = {
  code: 'RULE_EVAL_FAILED',
  message: 'bad rule',
  source: 'rules-engine',
  cause: new Error('x'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

type SendCommand = ReturnType<typeof vi.fn<[string[]], Promise<unknown>>>;

function fakeClient(): { client: RedisClientLike; sendCommand: SendCommand } {
  const sendCommand: SendCommand = vi.fn().mockResolvedValue(1);
  return { client: { sendCommand }, sendCommand };
}

function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('RedisErrorAdapter (list mode)', () => {
  it('RPUSHes one JSON record with a UUID id and no trim by default', async () => {
    const { client, sendCommand } = fakeClient();

    const result = await new RedisErrorAdapter(client).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    const [command, key, json] = sendCommand.mock.calls[0]?.[0] ?? [];
    expect(command).toBe('RPUSH');
    expect(key).toBe('error_log');
    const record = JSON.parse(json ?? '') as Record<string, unknown>;
    expect(record['id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(record).toMatchObject({
      code: 'RULE_EVAL_FAILED',
      message: 'bad rule',
      source: 'rules-engine',
      timestamp: '2026-01-02T03:04:05.678Z',
      cause: { name: 'Error', message: 'x' },
    });
  });

  it('LPUSHes onto a custom key when side is left', async () => {
    const { client, sendCommand } = fakeClient();

    await new RedisErrorAdapter(client, {
      side: 'left',
      key: 'app:errors',
    }).log(ENTRY);

    expect(sendCommand.mock.calls[0]?.[0].slice(0, 2)).toEqual([
      'LPUSH',
      'app:errors',
    ]);
  });

  it.each([
    ['right', ['LTRIM', 'error_log', '-100', '-1']],
    ['left', ['LTRIM', 'error_log', '0', '99']],
  ] as const)(
    'trims to the newest maxEntries when pushing on the %s',
    async (side, trim) => {
      const { client, sendCommand } = fakeClient();

      const result = await new RedisErrorAdapter(client, {
        side,
        maxEntries: 100,
      }).log(ENTRY);

      expect(result).toEqual({ ok: true });
      expect(sendCommand).toHaveBeenCalledTimes(2);
      expect(sendCommand.mock.calls[1]?.[0]).toEqual(trim);
    }
  );

  it('still reports success, but logs the problem, if only the trim fails', async () => {
    const { client, sendCommand } = fakeClient();
    sendCommand.mockImplementation(async (args: string[]) => {
      if (args[0] === 'LTRIM') {
        throw new Error(
          'READONLY You can not write against a read only replica'
        );
      }
      return 1;
    });
    const spy = silenceConsole();

    const result = await new RedisErrorAdapter(client, {
      maxEntries: 10,
    }).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining(
        'stored the entry but could not trim list "error_log" to 10 entries'
      )
    );
    spy.mockRestore();
  });

  it('returns a failure result naming the key if the push fails, and skips the trim', async () => {
    const { client, sendCommand } = fakeClient();
    sendCommand.mockRejectedValue(new Error('Connection is closed.'));
    const spy = silenceConsole();

    const result = await new RedisErrorAdapter(client, {
      maxEntries: 10,
      prefix: '[my-app]',
    }).log(ENTRY);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('list "error_log"');
    expect(result.error).toContain('Connection is closed.');
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      '[my-app] RedisErrorAdapter:',
      expect.any(Error)
    );
    spy.mockRestore();
  });

  it('returns a failure result, without sending anything, if the cause cannot be serialized', async () => {
    const { client, sendCommand } = fakeClient();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const spy = silenceConsole();

    const result = await new RedisErrorAdapter(client).log({
      ...ENTRY,
      cause: circular,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('circular');
    expect(sendCommand).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('RedisErrorAdapter (stream mode)', () => {
  it('XADDs the entry as separate fields with an auto-generated stream id', async () => {
    const { client, sendCommand } = fakeClient();

    const result = await new RedisErrorAdapter(client, { mode: 'stream' }).log(
      ENTRY
    );

    expect(result).toEqual({ ok: true });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    const command = sendCommand.mock.calls[0]?.[0] ?? [];
    expect(command.slice(0, 3)).toEqual(['XADD', 'error_log', '*']);
    const fields = new Map<string, string>();
    for (let index = 3; index < command.length; index += 2) {
      fields.set(command[index] ?? '', command[index + 1] ?? '');
    }
    expect(fields.get('id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(fields.get('code')).toBe('RULE_EVAL_FAILED');
    expect(fields.get('message')).toBe('bad rule');
    expect(fields.get('timestamp')).toBe('2026-01-02T03:04:05.678Z');
    expect(fields.get('source')).toBe('rules-engine');
    expect(JSON.parse(fields.get('cause') ?? '')).toMatchObject({
      name: 'Error',
      message: 'x',
    });
  });

  it('caps the stream with an exact MAXLEN', async () => {
    const { client, sendCommand } = fakeClient();

    await new RedisErrorAdapter(client, {
      mode: 'stream',
      key: 's',
      maxEntries: 500,
    }).log(ENTRY);

    expect(sendCommand.mock.calls[0]?.[0].slice(0, 6)).toEqual([
      'XADD',
      's',
      'MAXLEN',
      '=',
      '500',
      '*',
    ]);
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('leaves out cause and source when the entry has none', async () => {
    const { client, sendCommand } = fakeClient();

    await new RedisErrorAdapter(client, { mode: 'stream' }).log({
      code: 'X',
      message: 'm',
      timestamp: ENTRY.timestamp,
    });

    const command = sendCommand.mock.calls[0]?.[0] ?? [];
    expect(command).not.toContain('cause');
    expect(command).not.toContain('source');
  });

  it('returns a failure result naming the stream if XADD fails', async () => {
    const { client, sendCommand } = fakeClient();
    sendCommand.mockRejectedValue(
      new Error(
        'WRONGTYPE Operation against a key holding the wrong kind of value'
      )
    );
    const spy = silenceConsole();

    const result = await new RedisErrorAdapter(client, { mode: 'stream' }).log(
      ENTRY
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('stream "error_log"');
    expect(result.error).toContain('WRONGTYPE');
    spy.mockRestore();
  });
});

describe('RedisErrorAdapter options', () => {
  const { client } = fakeClient();

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects maxEntries of %s',
    (maxEntries: number) => {
      expect(() => new RedisErrorAdapter(client, { maxEntries })).toThrowError(
        /maxEntries must be a positive integer/
      );
    }
  );

  it('rejects an empty key', () => {
    expect(() => new RedisErrorAdapter(client, { key: '' })).toThrowError(
      /key must not be empty/
    );
  });

  it('rejects an unknown mode or side', () => {
    expect(
      () => new RedisErrorAdapter(client, { mode: 'set' as 'list' })
    ).toThrowError(/mode must be "list" or "stream", received "set"/);
    expect(
      () => new RedisErrorAdapter(client, { side: 'middle' as 'left' })
    ).toThrowError(/side must be "left" or "right", received "middle"/);
  });
});
