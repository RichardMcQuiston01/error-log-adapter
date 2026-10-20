/**
 * Live test for MongoDbErrorAdapter against a real MongoDB server through the
 * official driver. It is skipped unless MONGODB_TEST_URL is set, so
 * `bun run test` and CI never touch a server.
 *
 * Start a server and run it:
 *
 *   docker run -d -p 27017:27017 mongo:7
 *   MONGODB_TEST_URL=mongodb://127.0.0.1:27017 bun run test:live
 *
 * The test writes to a database named `error_log_live_test_<id>` and drops it
 * when it finishes.
 */
import { MongoClient, ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoDbErrorAdapter } from './mongodb-error-adapter.js';

const url: string | undefined = process.env['MONGODB_TEST_URL'];
const isConfigured: boolean = url !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const databaseName = `error_log_live_test_${runId}`;

describe.skipIf(!isConfigured)(
  'MongoDbErrorAdapter against a real server',
  () => {
    const client = new MongoClient(url ?? 'mongodb://127.0.0.1:27017', {
      serverSelectionTimeoutMS: 5000,
    });

    function collection(name: string): Collection<Document> {
      return client.db(databaseName).collection(name);
    }

    beforeAll(async () => {
      await client.connect();
    });

    afterAll(async () => {
      await client.db(databaseName).dropDatabase();
      await client.close();
    });

    it('inserts an entry as a document with an ObjectId when no id is given', async () => {
      const target = collection('basic');
      const adapter = new MongoDbErrorAdapter(target);
      const result = await adapter.log({
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        cause: new Error('the cause'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(result).toEqual({ ok: true });
      const stored = await target.findOne({ code: 'LIVE_ONE' });
      expect(stored).toMatchObject({
        code: 'LIVE_ONE',
        message: 'first live entry',
        source: 'live-test',
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(stored?.['_id']).toBeInstanceOf(ObjectId);
      expect(JSON.stringify(stored?.['cause'])).toContain('the cause');
    });

    it('leaves out an absent cause and source', async () => {
      const target = collection('sparse');
      await new MongoDbErrorAdapter(target).log({
        code: 'LIVE_SPARSE',
        message: 'no extras',
      });
      const stored = await target.findOne({ code: 'LIVE_SPARSE' });
      expect(stored).not.toBeNull();
      expect('cause' in (stored ?? {})).toBe(false);
      expect('source' in (stored ?? {})).toBe(false);
    });

    it('uses the entry id as _id when the caller gives one', async () => {
      const target = collection('callerid');
      const id = '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60';
      await new MongoDbErrorAdapter(target).log({
        id,
        code: 'LIVE_ID',
        message: 'has an id',
      });
      const stored = await target.findOne({ _id: id as unknown as ObjectId });
      expect(stored).toMatchObject({ code: 'LIVE_ID' });
    });

    it('stores a retry of the same id once, and counts the duplicate-key error as success', async () => {
      const target = collection('repeat');
      const adapter = new MongoDbErrorAdapter(target);
      const entry = {
        id: '11111111-2222-4333-8444-555555555555',
        code: 'LIVE_REPEAT',
        message: 'first',
      };
      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log({ ...entry, message: 'second' })).toEqual({
        ok: true,
      });
      expect(await target.countDocuments()).toBe(1);
      expect((await target.findOne({}))?.['message']).toBe('first');
    });

    it('stores entries without an id each time, since they cannot be matched', async () => {
      const target = collection('noid');
      const adapter = new MongoDbErrorAdapter(target);
      const entry = { code: 'LIVE_NOID', message: 'same text' };
      await adapter.log(entry);
      await adapter.log(entry);
      expect(await target.countDocuments()).toBe(2);
    });

    it('stores awkward text and nested causes exactly as given', async () => {
      const target = collection('text');
      const message =
        'quote " backslash \\ new line \n tab \t é 日本 😀 \u0000 $set {"a":1}';
      await new MongoDbErrorAdapter(target).log({
        code: 'LIVE_TEXT',
        message,
        cause: { 'dotted.key': 1, $dollar: 2, nested: { deep: [1, 2, 3] } },
      });
      const stored = await target.findOne({ code: 'LIVE_TEXT' });
      expect(stored?.['message']).toBe(message);
      expect(stored?.['cause']).toBeTruthy();
    });

    it('reports a duplicate-key error that is not a retry (a unique index on another field)', async () => {
      const target = collection('unique');
      await target.createIndex({ code: 1 }, { unique: true });
      const adapter = new MongoDbErrorAdapter(target);
      expect(await adapter.log({ code: 'LIVE_UNIQUE', message: 'a' })).toEqual({
        ok: true,
      });
      const result = await adapter.log({ code: 'LIVE_UNIQUE', message: 'b' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('E11000');
    });

    it('reports an unreachable server instead of throwing', async () => {
      const dead = new MongoClient('mongodb://127.0.0.1:1', {
        serverSelectionTimeoutMS: 1000,
      });
      const adapter = new MongoDbErrorAdapter(
        dead.db(databaseName).collection('dead'),
        { timeoutMs: 15_000 }
      );
      const result = await adapter.log({ code: 'LIVE_FAIL', message: 'no' });
      await dead.close();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
);
