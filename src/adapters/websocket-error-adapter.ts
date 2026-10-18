import { resolveEntryId } from '../entry-id.js';
import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { serializeEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** `readyState` of an open socket, the same in browsers, Node, Deno, Bun, and the `ws` package. */
const OPEN = 1;

const STATE_NAMES: Readonly<Record<number, string>> = {
  0: 'still connecting',
  1: 'open',
  2: 'closing',
  3: 'closed',
};

/**
 * The only things this adapter needs from a socket: `send` and `readyState`. The
 * browser `WebSocket`, Node's global `WebSocket`, Deno, Bun, and the `ws` package
 * all fit as they are.
 */
export interface WebSocketLike {
  send(data: string): unknown;
  readonly readyState: number;
}

export interface WebSocketErrorOptions {
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/**
 * Sends each entry as one JSON text message (the serialized entry plus its UUID
 * `id`) over a socket you own. You connect, and reconnect, the socket; this
 * adapter never opens one and keeps no buffer. If the socket is not open when
 * `log` is called, the entry is not sent and `log` returns `ok: false`, so
 * combine it with a durable adapter in a `CompositeErrorAdapter` when entries
 * must not be lost while the socket is down.
 *
 * `ok: true` means the socket accepted the message, not that the server
 * received it: a WebSocket gives no acknowledgement, and a connection that
 * drops after `send` loses the message.
 *
 * ```ts
 * const socket = new WebSocket('wss://logs.example.com/errors');
 * const adapter = new WebSocketErrorAdapter(socket);
 * ```
 */
export class WebSocketErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly prefix: string;

  constructor(
    private readonly socket: WebSocketLike,
    options: WebSocketErrorOptions = {}
  ) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const state: number = this.socket.readyState;
      if (state !== OPEN) {
        throw new Error(
          `the socket is ${STATE_NAMES[state] ?? `in unknown state ${String(state)}`} (readyState ${String(state)}), so the entry was not sent; connect or reconnect it first`
        );
      }
      this.socket.send(
        JSON.stringify({ id: resolveEntryId(entry), ...serializeEntry(entry) })
      );
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'WebSocketErrorAdapter',
        prefix: this.prefix,
        action: 'to send over the socket',
        error,
      });
    }
  }
}
