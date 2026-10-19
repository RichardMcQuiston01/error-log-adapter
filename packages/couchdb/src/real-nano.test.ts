// Runs the adapter with the real `nano` client against a small in-memory
// CouchDB stand-in on 127.0.0.1. The stand-in implements what the adapter uses
// (create a document, 409 on an existing id, `_bulk_docs`, 404 for a missing
// database, 401 without credentials), with the answers real CouchDB gives. The
// same adapter was also run against PouchDB Server; no CouchDB server is
// involved here. It also compiles the real client type against the adapter's
// `CouchDbDatabaseLike`.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import nano from 'nano';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { CouchDbErrorAdapter } from './couchdb-error-adapter.js';
import type { CouchDbDatabaseLike } from './couchdb-error-adapter.js';

interface StoredDoc {
  _id: string;
  [field: string]: unknown;
}

let server: Server;
let baseUrl = '';
let databases: Map<string, Map<string, StoredDoc>>;
let requireAuth = false;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function store(db: Map<string, StoredDoc>, doc: StoredDoc): object {
  if (db.has(doc._id)) {
    return {
      id: doc._id,
      error: 'conflict',
      reason: 'Document update conflict.',
    };
  }
  db.set(doc._id, doc);
  return { ok: true, id: doc._id, rev: '1-abc' };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    let raw = '';
    req.on('data', (chunk: Buffer): void => {
      raw += chunk.toString('utf8');
    });
    req.on('end', (): void => {
      if (requireAuth && req.headers.authorization === undefined) {
        reply(res, 401, {
          error: 'unauthorized',
          reason: 'Authentication required.',
        });
        return;
      }
      const [, dbName = '', rest] = (req.url ?? '').split('/');
      const db = databases.get(dbName);
      if (db === undefined) {
        reply(res, 404, {
          error: 'not_found',
          reason: 'Database does not exist.',
        });
        return;
      }
      if (req.method === 'POST' && rest === '_bulk_docs') {
        const { docs } = JSON.parse(raw) as { docs: StoredDoc[] };
        reply(
          res,
          201,
          docs.map((doc) => store(db, doc))
        );
        return;
      }
      if (req.method === 'POST' && rest === undefined) {
        const result = store(db, JSON.parse(raw) as StoredDoc) as {
          error?: string;
          reason?: string;
        };
        reply(res, result.error === undefined ? 201 : 409, result);
        return;
      }
      reply(res, 400, { error: 'bad_request', reason: 'Unsupported request.' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  databases = new Map([['error_log', new Map()]]);
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

function adapterFor(dbName: string): CouchDbErrorAdapter {
  const database = nano(baseUrl).use(dbName);
  const like: CouchDbDatabaseLike = database;
  return new CouchDbErrorAdapter(like);
}

describe('CouchDbErrorAdapter with the real nano client', () => {
  it('stores the document under the entry id', async () => {
    expect(await adapterFor('error_log').log(entry)).toEqual({ ok: true });
    const stored = databases.get('error_log')?.get(entry.id);
    expect(stored).toMatchObject({
      _id: entry.id,
      type: 'error_log',
      code: 'DB_DOWN',
      source: 'checkout',
      cause: { reason: 'ECONNREFUSED' },
      occurred_at: entry.timestamp,
    });
  });

  it('logging the same entry again keeps one document and reports success', async () => {
    const adapter = adapterFor('error_log');
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(await adapter.log(entry)).toEqual({ ok: true });
    expect(databases.get('error_log')?.size).toBe(1);
  });

  it('writes a batch, counting entries that already exist as stored', async () => {
    const adapter = adapterFor('error_log');
    await adapter.log(entry);
    const result = await adapter.logBatch([
      entry,
      { code: 'B', message: 'second' },
    ]);
    expect(result).toEqual({ ok: true });
    expect(databases.get('error_log')?.size).toBe(2);
  });

  it('reports a missing database with the server reason', async () => {
    const result = await adapterFor('nowhere').log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'CouchDB answered HTTP 404 (not_found): Database does not exist.'
    );
  });

  it('reports missing credentials', async () => {
    requireAuth = true;
    const result = await adapterFor('error_log').log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'CouchDB answered HTTP 401 (unauthorized): Authentication required.'
    );
  });

  it('reports an unreachable server', async () => {
    const database = nano('http://127.0.0.1:1').use('error_log');
    const result = await new CouchDbErrorAdapter(database).log(entry);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CouchDbErrorAdapter failed');
  });
});
