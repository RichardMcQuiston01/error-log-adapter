/**
 * Live test for CloudWatchLogsErrorAdapter against real CloudWatch Logs (or an
 * emulator such as LocalStack). It is skipped unless CLOUDWATCH_TEST_REGION is
 * set, so `npm test` and CI never touch AWS.
 *
 * Run it (credentials come from the usual AWS provider chain):
 *
 *   CLOUDWATCH_TEST_REGION=us-east-1 npm run test:live
 *
 * Optional: CLOUDWATCH_TEST_ENDPOINT (for LocalStack; with it the access key
 * variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY still have to be set,
 * to any value).
 *
 * Every run creates its own log group, `/error-log-adapter-live-test/<run id>`,
 * and deletes it again afterwards. The credentials need logs:CreateLogGroup,
 * logs:CreateLogStream, logs:PutLogEvents, logs:GetLogEvents and
 * logs:DeleteLogGroup on that group name.
 */
import { CloudWatchLogs } from '@aws-sdk/client-cloudwatch-logs';
import { afterAll, describe, expect, it } from 'vitest';
import { CloudWatchLogsErrorAdapter } from './cloudwatch-logs-error-adapter.js';

const region: string | undefined = process.env['CLOUDWATCH_TEST_REGION'];
const isConfigured: boolean = region !== undefined;

const runId: string = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const logGroupName: string = `/error-log-adapter-live-test/${runId}`;

interface StoredEvent {
  timestamp: number;
  message: string;
}

describe.skipIf(!isConfigured)(
  'CloudWatchLogsErrorAdapter against real CloudWatch Logs',
  () => {
    const client: CloudWatchLogs = new CloudWatchLogs({
      region,
      endpoint: process.env['CLOUDWATCH_TEST_ENDPOINT'],
    });

    /** Reads a stream's events, waiting a little for them to become visible. */
    async function readEvents(
      logStreamName: string,
      expectedCount: number
    ): Promise<StoredEvent[]> {
      let events: StoredEvent[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await client.getLogEvents({
          logGroupName,
          logStreamName,
          startFromHead: true,
        });
        events = (response.events ?? []).map((event) => ({
          timestamp: event.timestamp ?? 0,
          message: event.message ?? '',
        }));
        if (events.length >= expectedCount) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
      return events;
    }

    afterAll(async () => {
      try {
        await client.deleteLogGroup({ logGroupName });
      } catch (error: unknown) {
        console.error(
          `Could not delete the live-test log group ${logGroupName}; delete it by hand.`,
          error
        );
      }
    }, 30_000);

    it('creates the missing group and stream, then stores the entry as JSON', async () => {
      const logStreamName = 'single';
      const adapter = new CloudWatchLogsErrorAdapter(
        client,
        logGroupName,
        logStreamName
      );
      const timestamp: string = new Date().toISOString();

      const result = await adapter.log({
        code: 'LIVE_TEST',
        message: 'one event per entry',
        source: 'live-test',
        cause: new Error('boom'),
        timestamp,
      });

      expect(result).toEqual({ ok: true });
      const events: StoredEvent[] = await readEvents(logStreamName, 1);
      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe(Date.parse(timestamp));
      expect(JSON.parse(events[0]?.message ?? '{}')).toMatchObject({
        code: 'LIVE_TEST',
        message: 'one event per entry',
        source: 'live-test',
        timestamp,
        cause: { name: 'Error', message: 'boom' },
      });
    }, 60_000);

    it('sends a full batch in one request, and flush() sends the rest', async () => {
      const logStreamName = 'batched';
      const adapter = new CloudWatchLogsErrorAdapter(
        client,
        logGroupName,
        logStreamName,
        { batch: { batchSize: 3 } }
      );

      for (const message of ['b1', 'b2', 'b3', 'b4']) {
        expect(await adapter.log({ code: 'LIVE_TEST', message })).toEqual({
          ok: true,
        });
      }
      expect(await adapter.flush()).toEqual({ ok: true });

      const events: StoredEvent[] = await readEvents(logStreamName, 4);
      const messages: string[] = events.map(
        (event) => (JSON.parse(event.message) as { message: string }).message
      );
      expect(messages.sort()).toEqual(['b1', 'b2', 'b3', 'b4']);
    }, 60_000);

    it('reports ok: false for an event CloudWatch rejects as too old', async () => {
      const adapter = new CloudWatchLogsErrorAdapter(
        client,
        logGroupName,
        'too-old'
      );
      const twentyDaysAgo: string = new Date(
        Date.now() - 20 * 24 * 60 * 60 * 1000
      ).toISOString();

      const originalConsoleError = console.error;
      console.error = () => {};
      const result = await adapter.log({
        code: 'LIVE_TEST',
        message: 'older than the 14 day limit',
        timestamp: twentyDaysAgo,
      });
      console.error = originalConsoleError;

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }, 60_000);

    it('returns a descriptive failure for a missing group when createMissing is off', async () => {
      const missingGroup = `${logGroupName}-missing`;
      const adapter = new CloudWatchLogsErrorAdapter(
        client,
        missingGroup,
        'nope',
        { createMissing: false }
      );

      const originalConsoleError = console.error;
      console.error = () => {};
      const result = await adapter.log({ code: 'LIVE_TEST', message: 'nope' });
      console.error = originalConsoleError;

      expect(result.ok).toBe(false);
      expect(result.error).toContain(missingGroup);
    }, 60_000);
  }
);
