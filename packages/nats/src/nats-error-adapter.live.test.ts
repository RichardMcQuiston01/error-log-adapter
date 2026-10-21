/**
 * Live test for NatsErrorAdapter and NatsJetStreamErrorAdapter against a real
 * NATS server with JetStream. It is skipped unless NATS_TEST_URL is set, so
 * `bun run test` and CI never touch a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 4222:4222 nats:latest -js
 *   NATS_TEST_URL=nats://127.0.0.1:4222 bun run test:live
 *
 * The test creates JetStream streams named `ERROR_LOG_LIVE_TEST_<id>_*` and
 * deletes them when it finishes.
 */
import {
  JSONCodec,
  connect,
  headers,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  type Subscription,
} from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  NatsErrorAdapter,
  NatsJetStreamErrorAdapter,
} from './nats-error-adapter.js';

const url: string | undefined = process.env['NATS_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const streamPrefix = `ERROR_LOG_LIVE_TEST_${runId}`;
const subjectPrefix = `error_log_live_test_${runId}`;

interface Payload {
  id: string;
  code: string;
  message: string;
  source?: string;
  cause?: unknown;
  timestamp?: string;
}

describe.skipIf(!isConfigured)('NATS adapters against a real server', () => {
  const codec = JSONCodec<Payload>();
  let connection: NatsConnection;
  let jetstream: JetStreamClient;
  let manager: JetStreamManager;
  const streams: string[] = [];

  beforeAll(async () => {
    connection = await connect({ servers: url ?? 'nats://127.0.0.1:4222' });
    jetstream = connection.jetstream();
    manager = await connection.jetstreamManager();
  });

  afterAll(async () => {
    for (const stream of streams) {
      await manager.streams.delete(stream);
    }
    await connection.drain();
  });

  async function newStream(
    name: string
  ): Promise<{ stream: string; subject: string }> {
    const stream = `${streamPrefix}_${name}`;
    const subject = `${subjectPrefix}.${name}`;
    await manager.streams.add({ name: stream, subjects: [subject] });
    streams.push(stream);
    return { stream, subject };
  }

  async function messageCount(stream: string): Promise<number> {
    return (await manager.streams.info(stream)).state.messages;
  }

  describe('NatsErrorAdapter (core)', () => {
    async function collect(
      subject: string,
      count: number,
      publish: () => Promise<unknown>
    ): Promise<{ payloads: Payload[]; headerCodes: (string | undefined)[] }> {
      const subscription: Subscription = connection.subscribe(subject, {
        max: count,
      });
      await connection.flush();
      await publish();
      const payloads: Payload[] = [];
      const headerCodes: (string | undefined)[] = [];
      const timer = setTimeout(() => subscription.unsubscribe(), 5000);
      for await (const message of subscription) {
        payloads.push(codec.decode(message.data));
        headerCodes.push(message.headers?.get('code') || undefined);
      }
      clearTimeout(timer);
      return { payloads, headerCodes };
    }

    it('publishes an entry as a JSON message', async () => {
      const subject = `${subjectPrefix}.core.basic`;
      const adapter = new NatsErrorAdapter(connection, subject, {
        flush: true,
      });
      const { payloads } = await collect(subject, 1, () =>
        adapter.log({
          id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
          code: 'LIVE_ONE',
          message: 'first live entry',
          source: 'live-test',
          cause: new Error('the cause'),
          timestamp: '2026-01-02T03:04:05.678Z',
        })
      );
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
      });
      expect(JSON.stringify(payloads[0]?.cause)).toContain('the cause');
    });

    it('sends code and source as message headers when createHeaders is given', async () => {
      const subject = `${subjectPrefix}.core.headers`;
      const adapter = new NatsErrorAdapter(connection, subject, {
        flush: true,
        createHeaders: headers,
      });
      const { headerCodes } = await collect(subject, 1, () =>
        adapter.log({
          code: 'LIVE_HEADERS',
          message: 'with headers',
          source: 'x',
        })
      );
      expect(headerCodes).toEqual(['LIVE_HEADERS']);
    });

    it('publishes a batch', async () => {
      const subject = `${subjectPrefix}.core.batch`;
      const adapter = new NatsErrorAdapter(connection, subject, {
        flush: true,
      });
      const entries: ErrorLogEntry[] = [1, 2, 3].map((n) => ({
        code: 'LIVE_BATCH',
        message: `batch entry ${n}`,
      }));
      const { payloads } = await collect(subject, 3, () =>
        adapter.logBatch(entries)
      );
      expect(payloads.map((payload) => payload.message)).toEqual([
        'batch entry 1',
        'batch entry 2',
        'batch entry 3',
      ]);
    });

    it('reports a closed connection instead of throwing', async () => {
      const closed = await connect({ servers: url ?? 'nats://127.0.0.1:4222' });
      await closed.close();
      const adapter = new NatsErrorAdapter(
        closed,
        `${subjectPrefix}.core.closed`,
        {
          flush: true,
          timeoutMs: 15_000,
        }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('NatsJetStreamErrorAdapter', () => {
    it('stores an entry in the stream', async () => {
      const { stream, subject } = await newStream('basic');
      const adapter = new NatsJetStreamErrorAdapter(jetstream, subject);
      const id = '4a2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f61';
      const result = await adapter.log({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
      });
      expect(result).toEqual({ ok: true });
      expect(await messageCount(stream)).toBe(1);
      const stored = await manager.streams.getMessage(stream, { seq: 1 });
      expect(stored?.json<Payload>()).toMatchObject({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
      });
    });

    it('drops a repeat of the same entry using Nats-Msg-Id', async () => {
      const { stream, subject } = await newStream('repeat');
      const adapter = new NatsJetStreamErrorAdapter(jetstream, subject);
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'logged twice',
      };
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await messageCount(stream)).toBe(1);
    });

    it('stores a batch, dropping a repeat inside it', async () => {
      const { stream, subject } = await newStream('batch');
      const adapter = new NatsJetStreamErrorAdapter(jetstream, subject);
      const first: ErrorLogEntry = {
        id: '22222222-2222-4333-8444-555555555555',
        code: 'LIVE_BATCH',
        message: 'already there',
      };
      await adapter.log(first);
      const entries: ErrorLogEntry[] = [
        first,
        ...[1, 2, 3].map((n) => ({
          code: 'LIVE_BATCH',
          message: `batch entry ${n}`,
        })),
      ];
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      expect(await messageCount(stream)).toBe(4);
    });

    it('sends code and source as headers when createHeaders is given', async () => {
      const { stream, subject } = await newStream('headers');
      const adapter = new NatsJetStreamErrorAdapter(jetstream, subject, {
        createHeaders: headers,
      });
      await adapter.log({
        code: 'LIVE_HEADERS',
        message: 'with headers',
        source: 'src',
      });
      const stored = await manager.streams.getMessage(stream, { seq: 1 });
      expect(stored?.header.get('code')).toBe('LIVE_HEADERS');
      expect(stored?.header.get('source')).toBe('src');
    });

    it('reports a subject no stream captures instead of throwing', async () => {
      const adapter = new NatsJetStreamErrorAdapter(
        jetstream,
        `${subjectPrefix}.nobody.listens`,
        { timeoutMs: 15_000 }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      // The client's own error is a bare "503"; the result explains it.
      expect(result.error).toContain('NATS answered 503 (no responders)');
      expect(result.error).toContain(
        `no JetStream stream captures the subject "${subjectPrefix}.nobody.listens"`
      );
    });
  });
});
