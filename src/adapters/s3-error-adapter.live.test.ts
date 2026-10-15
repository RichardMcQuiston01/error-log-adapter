/**
 * Live test for S3ErrorAdapter against a real S3-compatible bucket, such as a
 * DigitalOcean Space. It is skipped unless the variables below are set, so
 * `npm test` and CI never touch a real bucket.
 *
 * Run it (example for a Space in nyc3):
 *
 *   S3_TEST_BUCKET=my-space \
 *   S3_TEST_ENDPOINT=https://nyc3.digitaloceanspaces.com \
 *   S3_TEST_ACCESS_KEY_ID=... \
 *   S3_TEST_SECRET_ACCESS_KEY=... \
 *   npm run test:live
 *
 * Optional: S3_TEST_REGION (default `us-east-1`; Spaces ignore it and use the
 * endpoint), S3_TEST_FORCE_PATH_STYLE=true (for MinIO and local emulators).
 * For real AWS S3, leave S3_TEST_ENDPOINT unset and set S3_TEST_REGION.
 *
 * Everything is written under a unique `error-log-adapter-live-test/<run id>/`
 * prefix and deleted again afterwards. The key needs read, write, list and
 * delete permission on the bucket.
 */
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3,
} from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { S3ErrorAdapter } from './s3-error-adapter.js';

const bucket: string | undefined = process.env['S3_TEST_BUCKET'];
const accessKeyId: string | undefined = process.env['S3_TEST_ACCESS_KEY_ID'];
const secretAccessKey: string | undefined =
  process.env['S3_TEST_SECRET_ACCESS_KEY'];
const isConfigured: boolean =
  bucket !== undefined &&
  accessKeyId !== undefined &&
  secretAccessKey !== undefined;

const runId: string = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const rootPrefix: string = `error-log-adapter-live-test/${runId}/`;

/** The SDK client every real user would build; only used when configured. */
function createClient(): S3 {
  return new S3({
    region: process.env['S3_TEST_REGION'] ?? 'us-east-1',
    endpoint: process.env['S3_TEST_ENDPOINT'],
    forcePathStyle: process.env['S3_TEST_FORCE_PATH_STYLE'] === 'true',
    credentials: {
      accessKeyId: accessKeyId ?? '',
      secretAccessKey: secretAccessKey ?? '',
    },
    // Some S3-compatible providers reject the SDK's default checksum headers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

describe.skipIf(!isConfigured)('S3ErrorAdapter against a real bucket', () => {
  const client: S3 = createClient();

  async function listKeys(prefix: string): Promise<string[]> {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
    );
    return (listed.Contents ?? []).map((object) => object.Key ?? '');
  }

  async function readObject(key: string): Promise<string> {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    return (await response.Body?.transformToString()) ?? '';
  }

  afterAll(async () => {
    const keys: string[] = await listKeys(rootPrefix);
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        })
      );
    }
  }, 30_000);

  it('writes one JSON object per entry, keyed by date and UUID', async () => {
    const prefix = `${rootPrefix}single/`;
    const adapter = new S3ErrorAdapter(client, bucket ?? '', {
      keyPrefix: prefix,
    });

    const result = await adapter.log({
      code: 'LIVE_TEST',
      message: 'one object per entry',
      source: 'live-test',
      cause: new Error('boom'),
      timestamp: '2026-01-02T03:04:05.678Z',
    });

    expect(result).toEqual({ ok: true });
    const keys = await listKeys(prefix);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      /\/2026\/01\/02\/20260102T030405678Z-[0-9a-f-]{36}\.json$/
    );
    const record = JSON.parse(await readObject(keys[0] ?? '')) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      code: 'LIVE_TEST',
      message: 'one object per entry',
      source: 'live-test',
      timestamp: '2026-01-02T03:04:05.678Z',
      cause: { name: 'Error', message: 'boom' },
    });
  }, 30_000);

  it('writes concurrent entries as separate objects', async () => {
    const prefix = `${rootPrefix}concurrent/`;
    const adapter = new S3ErrorAdapter(client, bucket ?? '', {
      keyPrefix: prefix,
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        adapter.log({ code: 'LIVE_TEST', message: `entry ${index}` })
      )
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(await listKeys(prefix)).toHaveLength(5);
  }, 30_000);

  it('uploads a full batch as one NDJSON object, and flush() sends the rest', async () => {
    const prefix = `${rootPrefix}batched/`;
    const adapter = new S3ErrorAdapter(client, bucket ?? '', {
      keyPrefix: prefix,
      batch: { batchSize: 3 },
    });

    for (const message of ['b1', 'b2', 'b3', 'b4']) {
      expect(await adapter.log({ code: 'LIVE_TEST', message })).toEqual({
        ok: true,
      });
    }
    expect(await adapter.flush()).toEqual({ ok: true });

    const keys = await listKeys(prefix);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.endsWith('.ndjson'))).toBe(true);
    const messages: string[] = [];
    for (const key of keys) {
      for (const line of (await readObject(key)).trim().split('\n')) {
        messages.push((JSON.parse(line) as { message: string }).message);
      }
    }
    expect(messages.sort()).toEqual(['b1', 'b2', 'b3', 'b4']);
  }, 30_000);

  it('returns a descriptive failure for a bucket that does not exist', async () => {
    const missingBucket = `error-log-adapter-no-such-bucket-${runId}`;
    const adapter = new S3ErrorAdapter(client, missingBucket);

    const originalConsoleError = console.error;
    console.error = () => {};
    const result = await adapter.log({ code: 'LIVE_TEST', message: 'nope' });
    console.error = originalConsoleError;

    expect(result.ok).toBe(false);
    expect(result.error).toContain(`bucket "${missingBucket}"`);
  }, 30_000);
});
