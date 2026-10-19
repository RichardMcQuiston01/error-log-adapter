import { resolveEntryId } from '../entry-id.js';
import { DEFAULT_PREFIX, reportFailure } from '../fail.js';
import { serializeEntry } from '../serialize.js';
import type { SerializedErrorLogEntry } from '../serialize.js';
import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '../types.js';

/** Default event name. It is not `error`, which Node's `EventEmitter` throws on when nobody listens. */
export const DEFAULT_EVENT_NAME = 'error-log';

/** What listeners receive: the serialized entry plus its UUID. */
export interface EventEmitterErrorRecord extends SerializedErrorLogEntry {
  id: string;
}

/**
 * The only thing this adapter needs from an emitter: `emit(eventName, payload)`.
 * Node's `EventEmitter` and mitt-style emitters fit as they are. A browser
 * `EventTarget` needs a one-line wrapper:
 *
 * ```ts
 * const target = new EventTarget();
 * const emitter: EmitterLike = {
 *   emit: (name, payload) =>
 *     target.dispatchEvent(new CustomEvent(name, { detail: payload })),
 * };
 * ```
 */
export interface EmitterLike {
  emit(eventName: string, payload: EventEmitterErrorRecord): unknown;
}

export interface EventEmitterErrorOptions {
  /**
   * Name of the event to emit. Defaults to `error-log`. Avoid `error` on a Node
   * `EventEmitter`: it throws when no listener is attached, and `log` would then
   * return `ok: false`.
   */
  eventName?: string;
  /**
   * Treat an emit that reached nobody as a failure. Node's `EventEmitter.emit`
   * returns `false` when there are no listeners; with this set to `true`, `log`
   * then returns `ok: false` instead of letting the entry vanish. Emitters whose
   * `emit` returns anything else (mitt, an `EventTarget` wrapper) cannot tell,
   * so they always count as delivered. Defaults to `false`.
   */
  requireListener?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
}

/**
 * Emits each entry as an event on an emitter you own, for in-process hooks such
 * as a toast, a metrics counter, or a test assertion. Listeners run
 * synchronously inside `emit`, so a listener that throws makes `log` return
 * `ok: false` with the listener's message; the application is not affected.
 *
 * ```ts
 * const bus = new EventEmitter();
 * bus.on('error-log', (record) => showToast(record.message));
 * const adapter = new EventEmitterErrorAdapter(bus);
 * ```
 */
export class EventEmitterErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly eventName: string;
  private readonly requireListener: boolean;
  private readonly prefix: string;

  /** @throws {RangeError} if `options.eventName` is empty. */
  constructor(
    private readonly emitter: EmitterLike,
    options: EventEmitterErrorOptions = {}
  ) {
    this.eventName = options.eventName ?? DEFAULT_EVENT_NAME;
    if (this.eventName === '') {
      throw new RangeError(
        'EventEmitterErrorAdapter: eventName must not be empty.'
      );
    }
    this.requireListener = options.requireListener ?? false;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const record: EventEmitterErrorRecord = {
        id: resolveEntryId(entry),
        ...serializeEntry(entry),
      };
      const delivered: unknown = this.emitter.emit(this.eventName, record);
      if (this.requireListener && delivered === false) {
        throw new Error(
          `no listener is attached to "${this.eventName}", so nothing received the entry`
        );
      }
      return { ok: true };
    } catch (error: unknown) {
      return reportFailure({
        adapterName: 'EventEmitterErrorAdapter',
        prefix: this.prefix,
        action: `to emit "${this.eventName}"`,
        error,
      });
    }
  }
}
