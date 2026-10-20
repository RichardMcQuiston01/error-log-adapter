/**
 * Live test for CouchDbErrorAdapter against a real Apache CouchDB server. It is
 * skipped unless COUCHDB_TEST_URL is set, so `bun run test` and CI never touch
 * a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=livetest123 couchdb:3
 *   COUCHDB_TEST_URL=http://admin:livetest123@127.0.0.1:5984 bun run test:live
 *
 * The test creates databases named `error_log_live_test_<id>_*` and destroys
 * them when it finishes.
 */
import nano from 'nano';
import type { DocumentScope, ServerScope } from 'nano';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  CouchDbErrorAdapter,
  buildErrorLogIndex,
} from './couchdb-error-adapter.js';

const url: string | undefined = process.env['COUCHDB_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const namePrefix = `error_log_live_test_${runId}`;

interface StoredDocument {
  _id: string;
  _rev: string;
  type?: string;
  code: string;
  message: string;
  source?: string;
  cause?: unknown;
  occurred_at: string;
  created_at: string;
}

describe.skipIf(!isConfigured)(
  'CouchDbErrorAdapter against a real server',
  () => {
    const server: ServerScope = nano(url ?? 'http://127.0.0.1:5984');
    const created: string[] = [];

    async function newDatabase(name: string): Promise<DocumentScope<unknown>> {
      const databaseName = `${namePrefix}_${name}`;
      await server.db.create(databaseName);
      created.push(databaseName);
      return server.use(databaseName);
    }

    afterAll(async () => {
      for (const name of created) {
        await server.db.destroy(name);
      }
    });

    it('stores an entry as a document keyed by its id', async () => {
      const database = await newDatabase('basic');
      const adapter = new CouchDbErrorAdapter(database);
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

      const stored = (await database.get(id)) as StoredDocument;
      expect(stored).toMatchObject({
        _id: id,
        type: 'error_log',
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        occurred_at: '2026-01-02T03:04:05.678Z',
      });
      expect(typeof stored.created_at).toBe('string');
      expect(typeof stored.cause).toBe('object');
      expect(JSON.stringify(stored.cause)).toContain('the cause');
    });

    it('leaves out an absent cause and source, and the type when docType is empty', async () => {
      const database = await newDatabase('sparse');
      const adapter = new CouchDbErrorAdapter(database, { docType: '' });
      const id = '4a2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f61';
      await adapter.log({ id, code: 'LIVE_SPARSE', message: 'no extras' });
      const stored = (await database.get(id)) as StoredDocument;
      expect('cause' in stored).toBe(false);
      expect('source' in stored).toBe(false);
      expect('type' in stored).toBe(false);
    });

    it('keeps the first write when the same entry is logged again', async () => {
      const database = await newDatabase('repeat');
      const adapter = new CouchDbErrorAdapter(database);
      const id = '11111111-2222-4333-8444-555555555555';
      expect(
        await adapter.log({ id, code: 'LIVE_REPEAT', message: 'first' })
      ).toEqual({ ok: true });
      expect(
        await adapter.log({ id, code: 'LIVE_REPEAT', message: 'second' })
      ).toEqual({ ok: true });
      const info = await server.db.get(`${namePrefix}_repeat`);
      expect(info.doc_count).toBe(1);
      expect(((await database.get(id)) as StoredDocument).message).toBe(
        'first'
      );
    });

    it('writes a batch, keeping an entry that already exists as it was', async () => {
      const database = await newDatabase('batch');
      const adapter = new CouchDbErrorAdapter(database);
      const existing: ErrorLogEntry = {
        id: '22222222-2222-4333-8444-555555555555',
        code: 'LIVE_BATCH',
        message: 'already there',
      };
      await adapter.log(existing);
      const entries: ErrorLogEntry[] = [
        { ...existing, message: 'rewritten?' },
        ...[1, 2, 3].map((n) => ({
          code: 'LIVE_BATCH',
          message: `batch entry ${n}`,
        })),
      ];
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      const info = await server.db.get(`${namePrefix}_batch`);
      expect(info.doc_count).toBe(4);
      expect(
        ((await database.get(existing.id ?? '')) as StoredDocument).message
      ).toBe('already there');
    });

    it('answers a time-range query through the index from buildErrorLogIndex', async () => {
      const database = await newDatabase('indexed');
      await database.createIndex(buildErrorLogIndex());
      const adapter = new CouchDbErrorAdapter(database);
      for (const hour of ['01', '03', '02']) {
        await adapter.log({
          code: `LIVE_${hour}`,
          message: 'ordering',
          timestamp: `2026-04-05T${hour}:00:00.000Z`,
        });
      }
      const result = await database.find({
        selector: {
          type: 'error_log',
          occurred_at: { $gte: '2026-04-05T02:00:00.000Z' },
        },
        sort: [{ type: 'desc' }, { occurred_at: 'desc' }],
      });
      expect((result.docs as StoredDocument[]).map((doc) => doc.code)).toEqual([
        'LIVE_03',
        'LIVE_02',
      ]);
      expect(result.warning).toBeUndefined();
    });

    it('reports a missing database instead of throwing', async () => {
      const adapter = new CouchDbErrorAdapter(
        server.use(`${namePrefix}_missing`),
        { timeoutMs: 15_000 }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('404');
    });

    it('reports a wrong login instead of throwing', async () => {
      const parsed = new URL(url ?? 'http://127.0.0.1:5984');
      parsed.password = 'definitely-not-the-password';
      const adapter = new CouchDbErrorAdapter(
        nano(parsed.toString()).use(`${namePrefix}_basic`),
        { timeoutMs: 15_000 }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('401');
    });
  }
);
