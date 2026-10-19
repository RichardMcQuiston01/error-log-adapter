/**
 * Live test for FirestoreErrorAdapter, including the expiry field a TTL policy
 * reads, against real Firestore (or the Firestore emulator). It is skipped
 * unless FIRESTORE_TEST_PROJECT_ID is set, so `npm test` and CI never touch a
 * real database.
 *
 * Run it (credentials come from GOOGLE_APPLICATION_CREDENTIALS or the
 * environment's default credentials):
 *
 *   FIRESTORE_TEST_PROJECT_ID=my-project npm run test:live
 *
 * Optional: FIRESTORE_TEST_DATABASE_ID (default `(default)`). To use the
 * emulator, also set FIRESTORE_EMULATOR_HOST (for example `127.0.0.1:8080`);
 * the SDK then needs no credentials.
 *
 * Everything is written to a unique `error-log-adapter-live-test-<run id>`
 * collection and deleted again afterwards. The test checks that the expiry
 * field is stored as a Firestore timestamp; it does not wait for Firestore to
 * delete expired documents, which can take a day or more.
 */
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { FirestoreErrorAdapter } from './firebase-error-adapter.js';

const projectId: string | undefined = process.env['FIRESTORE_TEST_PROJECT_ID'];
const isConfigured: boolean = projectId !== undefined;

const runId: string = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const collectionName: string = `error-log-adapter-live-test-${runId}`;

const ONE_DAY_MS: number = 24 * 60 * 60 * 1000;

describe.skipIf(!isConfigured)(
  'FirestoreErrorAdapter against a real Firestore database',
  () => {
    const firestore: Firestore = new Firestore({
      projectId,
      databaseId: process.env['FIRESTORE_TEST_DATABASE_ID'],
    });

    afterAll(async () => {
      try {
        await firestore.recursiveDelete(firestore.collection(collectionName));
      } catch (error: unknown) {
        console.error(
          `Could not delete the live-test collection ${collectionName}; delete it by hand.`,
          error
        );
      }
      await firestore.terminate();
    }, 60_000);

    it('writes the entry as a document keyed by its id', async () => {
      const adapter = new FirestoreErrorAdapter(
        firestore.collection(collectionName)
      );
      const id: string = crypto.randomUUID();

      const result = await adapter.log({
        id,
        code: 'LIVE_TEST',
        message: 'plain document',
        source: 'live-test',
        cause: new Error('boom'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });

      expect(result).toEqual({ ok: true });
      const snapshot = await firestore.collection(collectionName).doc(id).get();
      expect(snapshot.exists).toBe(true);
      expect(snapshot.data()).toMatchObject({
        id,
        code: 'LIVE_TEST',
        message: 'plain document',
        source: 'live-test',
        timestamp: '2026-01-02T03:04:05.678Z',
      });
      expect(JSON.parse(snapshot.get('cause') as string)).toMatchObject({
        name: 'Error',
        message: 'boom',
      });
      expect(snapshot.data()).not.toHaveProperty('expire_at');
    }, 60_000);

    it('stores expire_at as a Firestore timestamp the entry time plus expireAfterMs', async () => {
      const adapter = new FirestoreErrorAdapter(
        firestore.collection(collectionName),
        { expireAfterMs: 30 * ONE_DAY_MS }
      );
      const id: string = crypto.randomUUID();
      const timestamp = '2026-01-02T03:04:05.678Z';

      expect(
        await adapter.log({
          id,
          code: 'LIVE_TEST',
          message: 'expires',
          timestamp,
        })
      ).toEqual({ ok: true });

      const snapshot = await firestore.collection(collectionName).doc(id).get();
      const expireAt: unknown = snapshot.get('expire_at');
      expect(expireAt).toBeInstanceOf(Timestamp);
      expect((expireAt as Timestamp).toMillis()).toBe(
        Date.parse(timestamp) + 30 * ONE_DAY_MS
      );
    }, 60_000);

    it('uses a custom expireField', async () => {
      const adapter = new FirestoreErrorAdapter(
        firestore.collection(collectionName),
        { expireAfterMs: ONE_DAY_MS, expireField: 'delete_after' }
      );
      const id: string = crypto.randomUUID();

      expect(
        await adapter.log({ id, code: 'LIVE_TEST', message: 'custom field' })
      ).toEqual({ ok: true });

      const snapshot = await firestore.collection(collectionName).doc(id).get();
      expect(snapshot.get('delete_after')).toBeInstanceOf(Timestamp);
      expect(snapshot.get('expire_at')).toBeUndefined();
    }, 60_000);

    it('logging the same id again overwrites the document instead of adding one', async () => {
      const collection = firestore.collection(collectionName);
      const adapter = new FirestoreErrorAdapter(collection);
      const id: string = crypto.randomUUID();

      await adapter.log({ id, code: 'LIVE_TEST', message: 'retry me' });
      await adapter.log({ id, code: 'LIVE_TEST', message: 'retry me' });

      const matches = await collection.where('id', '==', id).get();
      expect(matches.size).toBe(1);
    }, 60_000);
  }
);
