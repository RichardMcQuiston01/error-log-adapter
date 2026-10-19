import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { WebSocketErrorAdapter } from './websocket-error-adapter.js';
import type { WebSocketLike } from './websocket-error-adapter.js';

const ID = '3f2b8c1e-5d4a-4e7b-9a10-2c6d8e0f1a2b';
const ENTRY: ErrorLogEntry = {
  code: 'PAYMENT_FAILED',
  message: 'card declined',
  source: 'checkout',
  cause: new Error('insufficient funds'),
  timestamp: '2026-01-02T03:04:05.678Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function fakeSocket(readyState: number) {
  const send = vi.fn<[string], unknown>();
  const socket: WebSocketLike = { send, readyState };
  return { socket, send };
}

describe('WebSocketErrorAdapter', () => {
  it('sends the serialized entry with a UUID id as one JSON message', async () => {
    const { socket, send } = fakeSocket(1);

    const result = await new WebSocketErrorAdapter(socket).log(ENTRY);

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    const message = JSON.parse(send.mock.calls[0][0]);
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(message).toMatchObject({
      code: 'PAYMENT_FAILED',
      message: 'card declined',
      source: 'checkout',
      timestamp: '2026-01-02T03:04:05.678Z',
      cause: { name: 'Error', message: 'insufficient funds' },
    });
  });

  it('gives each entry its own id and uses a caller-supplied one', async () => {
    const { socket, send } = fakeSocket(1);
    const adapter = new WebSocketErrorAdapter(socket);

    await adapter.log({ code: 'E', message: 'm' });
    await adapter.log({ code: 'E', message: 'm' });
    await adapter.log({
      code: 'E',
      message: 'm',
      id: ID.toUpperCase(),
    });

    const ids = send.mock.calls.map(([text]) => JSON.parse(text).id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ID);
  });

  it.each([
    [0, 'still connecting'],
    [2, 'closing'],
    [3, 'closed'],
  ])(
    'does not send and says why when readyState is %i',
    async (state: number, word: string) => {
      const spy = quiet();
      const { socket, send } = fakeSocket(state);

      const result = await new WebSocketErrorAdapter(socket).log(ENTRY);

      expect(send).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        `WebSocketErrorAdapter failed to send over the socket: the socket is ${word}`
      );
      expect(result.error).toContain('entry was not sent');
      expect(spy).toHaveBeenCalled();
    }
  );

  it('reports an unknown readyState', async () => {
    quiet();
    const { socket } = fakeSocket(7);
    const result = await new WebSocketErrorAdapter(socket).log(ENTRY);
    expect(result.error).toContain('unknown state 7');
  });

  it('reports a send that throws', async () => {
    const spy = quiet();
    const socket: WebSocketLike = {
      readyState: 1,
      send: () => {
        throw new Error('payload too large');
      },
    };

    const result = await new WebSocketErrorAdapter(socket).log(ENTRY);

    expect(result).toEqual({
      ok: false,
      error:
        'WebSocketErrorAdapter failed to send over the socket: payload too large',
    });
    expect(spy).toHaveBeenCalled();
  });

  it('reports an invalid entry id without sending', async () => {
    quiet();
    const { socket, send } = fakeSocket(1);

    const result = await new WebSocketErrorAdapter(socket).log({
      ...ENTRY,
      id: 'nope',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('entry.id must be a UUID');
    expect(send).not.toHaveBeenCalled();
  });

  it('reads readyState on every call, so a reconnected socket works again', async () => {
    quiet();
    const sent: string[] = [];
    const socket = {
      readyState: 3,
      send: (data: string) => void sent.push(data),
    };
    const adapter = new WebSocketErrorAdapter(socket);

    expect((await adapter.log(ENTRY)).ok).toBe(false);
    socket.readyState = 1;
    expect((await adapter.log(ENTRY)).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('uses a custom prefix in console output', async () => {
    const spy = quiet();
    const { socket } = fakeSocket(3);
    await new WebSocketErrorAdapter(socket, { prefix: '[app]' }).log(ENTRY);
    expect(spy.mock.calls[0][0]).toBe('[app] WebSocketErrorAdapter:');
  });
});
