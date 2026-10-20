/**
 * Live test for RabbitMqErrorAdapter against a real RabbitMQ broker. It is
 * skipped unless RABBITMQ_TEST_URL is set, so `bun run test` and CI never touch
 * a broker.
 *
 * Start a broker and run it:
 *
 *   docker run -d -p 5672:5672 rabbitmq:3
 *   RABBITMQ_TEST_URL=amqp://guest:guest@127.0.0.1:5672 bun run test:live
 *
 * The test declares queues and exchanges named `error_log_live_test_<id>_*` and
 * deletes them when it finishes.
 */
import amqp from 'amqplib';
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  GetMessage,
} from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import { RabbitMqErrorAdapter } from './rabbitmq-error-adapter.js';

const url: string | undefined = process.env['RABBITMQ_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const namePrefix = `error_log_live_test_${runId}`;

interface Body {
  id: string;
  code: string;
  message: string;
  source?: string;
  cause?: unknown;
}

describe.skipIf(!isConfigured)(
  'RabbitMqErrorAdapter against a real broker',
  () => {
    let connection: ChannelModel;
    let confirmChannel: ConfirmChannel;
    let plainChannel: Channel;
    const queues: string[] = [];
    const exchanges: string[] = [];

    beforeAll(async () => {
      connection = await amqp.connect(url ?? 'amqp://127.0.0.1');
      confirmChannel = await connection.createConfirmChannel();
      plainChannel = await connection.createChannel();
    });

    afterAll(async () => {
      const cleanup = await connection.createChannel();
      for (const queue of queues) {
        await cleanup.deleteQueue(queue);
      }
      for (const exchange of exchanges) {
        await cleanup.deleteExchange(exchange);
      }
      await connection.close();
    });

    async function newQueue(name: string): Promise<string> {
      const queue = `${namePrefix}_${name}`;
      await plainChannel.assertQueue(queue, { durable: true });
      queues.push(queue);
      return queue;
    }

    async function take(queue: string): Promise<GetMessage | false> {
      return plainChannel.get(queue, { noAck: true });
    }

    function body(message: GetMessage | false): Body {
      if (message === false) {
        throw new Error('expected a message in the queue, but it was empty');
      }
      return JSON.parse(message.content.toString('utf8')) as Body;
    }

    it('publishes an entry with the documented body, properties and headers', async () => {
      const queue = await newQueue('basic');
      const adapter = new RabbitMqErrorAdapter(confirmChannel, {
        routingKey: queue,
        confirm: true,
      });
      const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
      const result = await adapter.log({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        cause: new Error('the cause'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(result).toEqual({ ok: true });

      const message = await take(queue);
      expect(body(message)).toMatchObject({
        id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
      });
      if (message === false) {
        return;
      }
      expect(message.properties.messageId).toBe(id);
      expect(message.properties.type).toBe('LIVE_ONE');
      expect(message.properties.contentType).toBe('application/json');
      expect(message.properties.deliveryMode).toBe(2);
      expect(message.properties.timestamp).toBe(
        Math.floor(Date.parse('2026-01-02T03:04:05.678Z') / 1000)
      );
      expect(message.properties.headers).toMatchObject({
        code: 'LIVE_ONE',
        source: 'live-test',
      });
    });

    it('leaves the headers out when headers is false', async () => {
      const queue = await newQueue('noheaders');
      const adapter = new RabbitMqErrorAdapter(confirmChannel, {
        routingKey: queue,
        confirm: true,
        headers: false,
      });
      await adapter.log({
        code: 'LIVE_PLAIN',
        message: 'no headers',
        source: 'x',
      });
      const message = await take(queue);
      expect(message).not.toBe(false);
      if (message !== false) {
        expect(message.properties.headers?.['code']).toBeUndefined();
      }
    });

    it('delivers without confirm on a plain channel', async () => {
      const queue = await newQueue('plain');
      const adapter = new RabbitMqErrorAdapter(plainChannel, {
        routingKey: queue,
      });
      expect(
        await adapter.log({ code: 'LIVE_PLAIN', message: 'plain' })
      ).toEqual({
        ok: true,
      });
      await plainChannel.checkQueue(queue);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(body(await take(queue)).message).toBe('plain');
    });

    it('publishes a batch in order', async () => {
      const queue = await newQueue('batch');
      const adapter = new RabbitMqErrorAdapter(confirmChannel, {
        routingKey: queue,
        confirm: true,
      });
      const entries: ErrorLogEntry[] = [1, 2, 3].map((n) => ({
        code: 'LIVE_BATCH',
        message: `batch entry ${n}`,
      }));
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      const received: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        received.push(body(await take(queue)).message);
      }
      expect(received).toEqual([
        'batch entry 1',
        'batch entry 2',
        'batch entry 3',
      ]);
    });

    it('delivers a repeated entry twice, as the README says', async () => {
      const queue = await newQueue('repeat');
      const adapter = new RabbitMqErrorAdapter(confirmChannel, {
        routingKey: queue,
        confirm: true,
      });
      const entry: ErrorLogEntry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'logged twice',
      };
      await adapter.log(entry);
      await adapter.log(entry);
      const first = await take(queue);
      const second = await take(queue);
      expect(first).not.toBe(false);
      expect(second).not.toBe(false);
      expect(await take(queue)).toBe(false);
    });

    it('routes through a headers exchange on the code header', async () => {
      const exchange = `${namePrefix}_headers`;
      await plainChannel.assertExchange(exchange, 'headers', {
        durable: false,
      });
      exchanges.push(exchange);
      const queue = await newQueue('routed');
      await plainChannel.bindQueue(queue, exchange, '', {
        'x-match': 'all',
        code: 'LIVE_ROUTED',
      });
      const adapter = new RabbitMqErrorAdapter(confirmChannel, {
        exchange,
        routingKey: 'ignored',
        confirm: true,
      });
      await adapter.log({ code: 'LIVE_ROUTED', message: 'wanted' });
      await adapter.log({ code: 'LIVE_OTHER', message: 'not wanted' });
      expect(body(await take(queue)).message).toBe('wanted');
      expect(await take(queue)).toBe(false);
    });

    it('reports a missing exchange instead of throwing', async () => {
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => undefined);
      const adapter = new RabbitMqErrorAdapter(channel, {
        exchange: `${namePrefix}_does_not_exist`,
        routingKey: 'x',
        confirm: true,
        timeoutMs: 5000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('reports a closed connection instead of throwing', async () => {
      const other = await amqp.connect(url ?? 'amqp://127.0.0.1');
      const channel = await other.createConfirmChannel();
      await other.close();
      const adapter = new RabbitMqErrorAdapter(channel, {
        routingKey: `${namePrefix}_closed`,
        confirm: true,
        timeoutMs: 5000,
      });
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
