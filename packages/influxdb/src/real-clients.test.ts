// Runs both adapters with the real InfluxDB clients against a throwaway HTTP
// server on 127.0.0.1, so the client types, the request each client sends and
// the way each reports a rejected write are checked for real. No InfluxDB
// server is involved: the stub accepts or rejects whatever it is sent.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InfluxDB } from '@influxdata/influxdb-client';
import type { WriteApi } from '@influxdata/influxdb-client';
import { InfluxDBClient } from '@influxdata/influxdb3-client';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  InfluxDb3ErrorAdapter,
  InfluxDbErrorAdapter,
} from './influxdb-error-adapter.js';
import type {
  InfluxDb3ClientLike,
  InfluxWriteApiLike,
} from './influxdb-error-adapter.js';

interface Received {
  url: string;
  authorization: string | undefined;
  body: string;
}

let server: Server;
let baseUrl = '';
let status = 204;
let received: Received[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    let body = '';
    req.on('data', (chunk: Buffer): void => {
      body += chunk.toString('utf8');
    });
    req.on('end', (): void => {
      received.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });
      res.statusCode = status;
      if (status >= 400) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ code: 'invalid', message: `stub says ${status}` })
        );
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  status = 204;
  received = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const entry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  timestamp: '2026-10-19T05:00:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

describe('InfluxDbErrorAdapter with the real @influxdata/influxdb-client', () => {
  function adapter(): { writeApi: WriteApi; adapter: InfluxDbErrorAdapter } {
    const writeApi: WriteApi = new InfluxDB({
      url: baseUrl,
      token: 'secret',
    }).getWriteApi('my-org', 'my-bucket', 'ns', { maxRetries: 0 });
    const like: InfluxWriteApiLike = writeApi;
    return { writeApi, adapter: new InfluxDbErrorAdapter(like) };
  }

  it('sends the point to the write endpoint with the token', async () => {
    const { writeApi, adapter: errors } = adapter();
    expect(await errors.log(entry)).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe(
      '/api/v2/write?org=my-org&bucket=my-bucket&precision=ns'
    );
    expect(received[0]?.authorization).toBe('Token secret');
    expect(received[0]?.body).toMatch(
      /^error_log,code=DB_DOWN,source=checkout id="3f2b8c1e-[^"]+",message="cannot reach the database" \d{19}$/
    );
    await writeApi.close();
  });

  it.each([400, 401, 503])(
    'reports an HTTP %i as a failed result',
    async (code) => {
      status = code;
      const { writeApi, adapter: errors } = adapter();
      const result = await errors.log(entry);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('InfluxDbErrorAdapter failed to write');
      await writeApi.close().catch(() => undefined);
    }
  );
});

describe('InfluxDb3ErrorAdapter with the real @influxdata/influxdb3-client', () => {
  function adapter(): {
    client: InfluxDBClient;
    adapter: InfluxDb3ErrorAdapter;
  } {
    const client = new InfluxDBClient({
      host: baseUrl,
      token: 'secret',
      database: 'logs',
    });
    const like: InfluxDb3ClientLike = client;
    return {
      client,
      adapter: new InfluxDb3ErrorAdapter(like, { precision: 'ms' }),
    };
  }

  it('sends the point with the precision and the token', async () => {
    const { client, adapter: errors } = adapter();
    expect(await errors.log(entry)).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/api/v2/write?bucket=logs&precision=ms');
    expect(received[0]?.authorization).toBe('Token secret');
    expect(received[0]?.body).toBe(
      `error_log,code=DB_DOWN,source=checkout id="${entry.id}",message="cannot reach the database" ${Date.parse(entry.timestamp)}`
    );
    await client.close();
  });

  it.each([400, 401, 503])(
    'reports an HTTP %i as a failed result',
    async (code) => {
      status = code;
      const { client, adapter: errors } = adapter();
      const result = await errors.log(entry);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('InfluxDb3ErrorAdapter failed to write');
      await client.close();
    }
  );
});
