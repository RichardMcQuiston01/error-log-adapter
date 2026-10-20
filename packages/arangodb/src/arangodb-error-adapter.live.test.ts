/**
 * Live test for ArangoDbErrorAdapter against a real ArangoDB server. It is
 * skipped unless ARANGODB_TEST_URL is set, so `bun run test` and CI never
 * touch a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 8529:8529 -e ARANGO_ROOT_PASSWORD=livetest123 arangodb:3.12
 *   ARANGODB_TEST_URL=http://127.0.0.1:8529 ARANGODB_TEST_USER=root \
 *     ARANGODB_TEST_PASSWORD=livetest123 bun run test:live
 *
 * Optional: ARANGODB_TEST_DATABASE (default `_system`). The test creates
 * collections named `error_log_live_test_<id>_*` and drops them when it
 * finishes.
 */
import { Database } from 'arangojs';
import type { DocumentCollection } from 'arangojs/collections';
import { afterAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  ArangoDbErrorAdapter,
  buildErrorLogIndex,
} from './arangodb-error-adapter.js';

const url: string | undefined = process.env['ARANGODB_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const namePrefix = `error_log_live_test_${runId}`;

describe.skipIf(!isConfigured)(
  'ArangoDbErrorAdapter against a real server',
  () => {
    const user: string = process.env['ARANGODB_TEST_USER'] ?? 'root';
    const password: string = process.env['ARANGODB_TEST_PASSWORD'] ?? '';
    const db: Database = new Database({
      url: url ?? 'http://127.0.0.1:8529',
      databaseName: process.env['ARANGODB_TEST_DATABASE'] ?? '_system',
      auth: { username: user, password },
    });
    const created: string[] = [];

    async function newCollection(name: string): Promise<DocumentCollection> {
      const collectionName = `${namePrefix}_${name}`;
      const collection: DocumentCollection =
        await db.createCollection(collectionName);
      created.push(collectionName);
      return collection;
    }

    afterAll(async () => {
      for (const name of created) {
        await db.collection(name).drop();
      }
      db.close();
    });

    it('stores an entry as a document keyed by its id', async () => {
      const collection = await newCollection('basic');
      const adapter = new ArangoDbErrorAdapter(collection);
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

      const stored = await collection.document(id);
      expect(stored).toMatchObject({
        _key: id,
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        occurred_at: '2026-01-02T03:04:05.678Z',
      });
      expect(typeof stored['created_at']).toBe('string');
      expect(typeof stored['cause']).toBe('object');
      expect(JSON.stringify(stored['cause'])).toContain('the cause');
    });

    it('leaves out an absent cause and source', async () => {
      const collection = await newCollection('sparse');
      const adapter = new ArangoDbErrorAdapter(collection);
      const id = '4a2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f61';
      await adapter.log({ id, code: 'LIVE_SPARSE', message: 'no extras' });
      const stored = await collection.document(id);
      expect('cause' in stored).toBe(false);
      expect('source' in stored).toBe(false);
    });

    it('keeps the first write when the same entry is logged again', async () => {
      const collection = await newCollection('repeat');
      const adapter = new ArangoDbErrorAdapter(collection);
      const id = '11111111-2222-4333-8444-555555555555';
      expect(
        await adapter.log({ id, code: 'LIVE_REPEAT', message: 'first' })
      ).toEqual({ ok: true });
      expect(
        await adapter.log({ id, code: 'LIVE_REPEAT', message: 'second' })
      ).toEqual({ ok: true });
      expect(await collection.count()).toMatchObject({ count: 1 });
      expect(await collection.document(id)).toMatchObject({ message: 'first' });
    });

    it('writes a batch, skipping a key that already exists', async () => {
      const collection = await newCollection('batch');
      const adapter = new ArangoDbErrorAdapter(collection);
      const existing: ErrorLogEntry = {
        id: '22222222-2222-4333-8444-555555555555',
        code: 'LIVE_BATCH',
        message: 'already there',
      };
      await adapter.log(existing);
      const entries: ErrorLogEntry[] = [
        existing,
        ...[1, 2, 3].map((n) => ({
          code: 'LIVE_BATCH',
          message: `batch entry ${n}`,
        })),
      ];
      expect(await adapter.logBatch(entries)).toEqual({ ok: true });
      expect(await collection.count()).toMatchObject({ count: 4 });
    });

    it('works with the persistent index from buildErrorLogIndex', async () => {
      const collection = await newCollection('indexed');
      const index = await collection.ensureIndex(buildErrorLogIndex());
      expect(index.name).toBe('error_log_occurred_at');
      const adapter = new ArangoDbErrorAdapter(collection);
      for (const hour of ['01', '03', '02']) {
        await adapter.log({
          code: `LIVE_${hour}`,
          message: 'ordering',
          timestamp: `2026-04-05T${hour}:00:00.000Z`,
        });
      }
      const cursor = await db.query(
        `FOR e IN @@collection SORT e.occurred_at DESC RETURN e.code`,
        { '@collection': collection.name }
      );
      expect(await cursor.all()).toEqual(['LIVE_03', 'LIVE_02', 'LIVE_01']);
    });

    it('reports a missing collection with the ArangoDB error number', async () => {
      const adapter = new ArangoDbErrorAdapter(
        db.collection(`${namePrefix}_missing`),
        { timeoutMs: 15_000 }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('1203');
    });

    it('reports a failed login instead of throwing', async () => {
      const badDb = new Database({
        url: url ?? 'http://127.0.0.1:8529',
        databaseName: process.env['ARANGODB_TEST_DATABASE'] ?? '_system',
        auth: { username: user, password: 'definitely-not-the-password' },
      });
      const adapter = new ArangoDbErrorAdapter(
        badDb.collection(`${namePrefix}_nothing`),
        { timeoutMs: 15_000 }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      badDb.close();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
