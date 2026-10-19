// Runs the adapter with the real `arangojs` client against a small stand-in for
// ArangoDB's document HTTP API on 127.0.0.1. The stand-in follows the documented
// behavior of `POST /_db/{db}/_api/document/{collection}`: `overwriteMode=ignore`
// skips an existing `_key`, otherwise a repeat is error 1210 (HTTP 409), a batch
// is answered per document, a missing collection is error 1203 (HTTP 404) and a
// missing login is error 401. No ArangoDB server was available, so this checks
// the request the real client sends and how it reports each answer, not the
// server. It also compiles the real client type against `ArangoCollectionLike`.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Database } from 'arangojs';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ArangoDbErrorAdapter } from './arangodb-error-adapter.js';
import type { ArangoCollectionLike } from './arangodb-error-adapter.js';

interface Request {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let baseUrl = '';
let collections: Map<string, Map<string, Record<string, unknown>>>;
let requests: Request[];
let requireAuth = false;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-arango-queue-time-seconds', '0');
  res.end(JSON.stringify(body));
}

function errorBody(code: number, errorNum: number, errorMessage: string) {
  return { error: true, code, errorNum, errorMessage };
}

function insert(
  collection: Map<string, Record<string, unknown>>,
  doc: Record<string, unknown>,
  ignore: boolean
): Record<string, unknown> {
  const key = String(doc['_key']);
  if (collection.has(key)) {
    if (ignore) {
      return { _id: `error_log/${key}`, _key: key, _rev: '_old' };
    }
    return errorBody(
      409,
      1210,
      `unique constraint violated - in index primary of type primary over '_key'; conflicting key: ${key}`
    );
  }
  collection.set(key, doc);
  return { _id: `error_log/${key}`, _key: key, _rev: '_new' };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    let raw = '';
    req.on('data', (chunk: Buffer): void => {
      raw += chunk.toString('utf8');
    });
    req.on('end', (): void => {
      const url = new URL(req.url ?? '', 'http://localhost');
      requests.push({
        method: req.method ?? '',
        url: `${url.pathname}${url.search}`,
        authorization: req.headers.authorization,
        body: raw === '' ? undefined : JSON.parse(raw),
      });
      if (
        requireAuth &&
        req.headers.authorization !==
          `Basic ${Buffer.from('root:secret').toString('base64')}`
      ) {
        reply(res, 401, errorBody(401, 401, 'Unauthorized'));
        return;
      }
      const match = /^\/_db\/([^/]+)\/_api\/document\/([^/]+)$/.exec(
        url.pathname
      );
      if (req.method !== 'POST' || match === null) {
        reply(res, 400, errorBody(400, 400, 'unsupported request'));
        return;
      }
      const collection = collections.get(match[2] ?? '');
      if (collection === undefined) {
        reply(
          res,
          404,
          errorBody(404, 1203, `collection or view not found: ${match[2]}`)
        );
        return;
      }
      const ignore = url.searchParams.get('overwriteMode') === 'ignore';
      const body = JSON.parse(raw) as unknown;
      if (Array.isArray(body)) {
        reply(
          res,
          202,
          body.map((doc: Record<string, unknown>) =>
            insert(collection, doc, ignore)
          )
        );
        return;
      }
      const result = insert(
        collection,
        body as Record<string, unknown>,
        ignore
      );
      reply(res, result['error'] === true ? 409 : 202, result);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  collections = new Map([['error_log', new Map()]]);
  requests = [];
  requireAuth = false;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const entry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  cause: { reason: 'ECONNREFUSED' },
  timestamp: '2026-10-19T05:00:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

function adapterFor(
  collectionName: string,
  database = 'logs'
): {
  adapter: ArangoDbErrorAdapter;
  db: Database;
} {
  const db = new Database({ url: baseUrl, databaseName: database });
  const like: ArangoCollectionLike = db.collection(collectionName);
  return { adapter: new ArangoDbErrorAdapter(like), db };
}

describe('ArangoDbErrorAdapter with the real arangojs client', () => {
  it('posts the document to the collection with overwriteMode=ignore', async () => {
    const { adapter, db } = adapterFor('error_log');
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(
      '/_db/logs/_api/document/error_log?overwriteMode=ignore'
    );
    expect(collections.get('error_log')?.get(entry.id)).toMatchObject({
      _key: entry.id,
      code: 'DB_DOWN',
      cause: { reason: 'ECONNREFUSED' },
      occurred_at: entry.timestamp,
    });
    db.close();
  });

  it('logging the same entry again keeps one document and reports success', async () => {
    const { adapter, db } = adapterFor('error_log');
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(collections.get('error_log')?.size).toBe(1);
    db.close();
  });

  it('writes a batch in one request, counting existing keys as stored', async () => {
    const { adapter, db } = adapterFor('error_log');
    await adapter.log(entry);
    requests = [];
    const result = await adapter.logBatch([
      entry,
      { code: 'B', message: 'second' },
    ]);
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(Array.isArray(requests[0]?.body)).toBe(true);
    expect(collections.get('error_log')?.size).toBe(2);
    db.close();
  });

  it('reports a missing collection with the ArangoDB error number', async () => {
    const { adapter, db } = adapterFor('nowhere');
    const result = await adapter.log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'ArangoDB error 1203 (HTTP 404): collection or view not found: nowhere'
    );
    db.close();
  });

  it('reports wrong credentials', async () => {
    requireAuth = true;
    const { adapter, db } = adapterFor('error_log');
    const result = await adapter.log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ArangoDB error 401 (HTTP 401)');
    db.close();
  });

  it('sends basic credentials when the client has them', async () => {
    requireAuth = true;
    const { adapter, db } = adapterFor('error_log');
    db.useBasicAuth('root', 'secret');
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(requests.at(-1)?.authorization).toMatch(/^Basic /);
    db.close();
  });

  it('reports an unreachable server', async () => {
    const db = new Database({
      url: 'http://127.0.0.1:1',
      databaseName: 'logs',
    });
    const result = await new ArangoDbErrorAdapter(
      db.collection('error_log')
    ).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ArangoDbErrorAdapter failed');
    db.close();
  });
});
