/**
 * Live test for SnsErrorAdapter against real Amazon SNS and SQS (or an emulator
 * such as LocalStack or moto). It is skipped unless SNS_TEST_REGION is set, so
 * `npm test` and CI never touch AWS.
 *
 * Run it (credentials come from the usual AWS provider chain):
 *
 *   SNS_TEST_REGION=us-east-1 npm run test:live
 *
 * Optional: SNS_TEST_ENDPOINT, one endpoint for both SNS and SQS (for
 * LocalStack or moto; the access key variables AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY still have to be set, to any value).
 *
 * The test publishes to SNS topics it creates and reads the messages back from
 * SQS queues subscribed to them, then deletes the topics and queues (and with
 * them the subscriptions). Names start with `error-log-adapter-live-test-`.
 * The credentials need sns:CreateTopic, sns:Subscribe, sns:Publish,
 * sns:DeleteTopic, sqs:CreateQueue, sqs:GetQueueAttributes,
 * sqs:SetQueueAttributes, sqs:ReceiveMessage and sqs:DeleteQueue. The FIFO
 * test needs a region with FIFO topics.
 */
import { SNS } from '@aws-sdk/client-sns';
import { SQS } from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, it } from 'vitest';
import { SnsErrorAdapter } from './sns-error-adapter.js';

const region: string | undefined = process.env['SNS_TEST_REGION'];
const isConfigured: boolean = region !== undefined;

const runId: string = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const namePrefix = `error-log-adapter-live-test-${runId}`;

/** The SNS envelope SQS receives when raw message delivery is off. */
interface SnsEnvelope {
  Type: string;
  Subject?: string;
  Message: string;
  MessageAttributes?: Record<string, { Type: string; Value: string }>;
}

describe.skipIf(!isConfigured)(
  'SnsErrorAdapter against real SNS and SQS',
  () => {
    const endpoint: string | undefined = process.env['SNS_TEST_ENDPOINT'];
    const sns: SNS = new SNS({ region, endpoint });
    const sqs: SQS = new SQS({ region, endpoint });
    const topicArns: string[] = [];
    const queueUrls: string[] = [];

    async function createTopic(name: string, fifo: boolean): Promise<string> {
      const created = await sns.createTopic({
        Name: fifo ? `${name}.fifo` : name,
        Attributes: fifo
          ? { FifoTopic: 'true', ContentBasedDeduplication: 'false' }
          : undefined,
      });
      const topicArn: string = created.TopicArn ?? '';
      topicArns.push(topicArn);
      return topicArn;
    }

    /** Creates a queue that the topic may publish to, and subscribes it. */
    async function subscribeQueue(
      name: string,
      topicArn: string,
      options: { fifo?: boolean; filterPolicy?: object } = {}
    ): Promise<string> {
      const created = await sqs.createQueue({
        QueueName: options.fifo ? `${name}.fifo` : name,
        Attributes: options.fifo ? { FifoQueue: 'true' } : undefined,
      });
      const queueUrl: string = created.QueueUrl ?? '';
      queueUrls.push(queueUrl);
      const attributes = await sqs.getQueueAttributes({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      });
      const queueArn: string = attributes.Attributes?.['QueueArn'] ?? '';
      await sqs.setQueueAttributes({
        QueueUrl: queueUrl,
        Attributes: {
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'sns.amazonaws.com' },
                Action: 'sqs:SendMessage',
                Resource: queueArn,
                Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
              },
            ],
          }),
        },
      });
      await sns.subscribe({
        TopicArn: topicArn,
        Protocol: 'sqs',
        Endpoint: queueArn,
        Attributes:
          options.filterPolicy === undefined
            ? undefined
            : { FilterPolicy: JSON.stringify(options.filterPolicy) },
      });
      return queueUrl;
    }

    /** Reads envelopes from a queue until `expected` have arrived or `waitSeconds` pass. */
    async function receive(
      queueUrl: string,
      expected: number,
      waitSeconds = 20
    ): Promise<SnsEnvelope[]> {
      const envelopes: SnsEnvelope[] = [];
      const deadline: number = Date.now() + waitSeconds * 1000;
      while (envelopes.length < expected && Date.now() < deadline) {
        const response = await sqs.receiveMessage({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2,
        });
        for (const message of response.Messages ?? []) {
          envelopes.push(JSON.parse(message.Body ?? '{}') as SnsEnvelope);
        }
      }
      return envelopes;
    }

    afterAll(async () => {
      for (const topicArn of topicArns) {
        try {
          await sns.deleteTopic({ TopicArn: topicArn });
        } catch (error: unknown) {
          console.error(
            `Could not delete the live-test topic ${topicArn}; delete it by hand.`,
            error
          );
        }
      }
      for (const queueUrl of queueUrls) {
        try {
          await sqs.deleteQueue({ QueueUrl: queueUrl });
        } catch (error: unknown) {
          console.error(
            `Could not delete the live-test queue ${queueUrl}; delete it by hand.`,
            error
          );
        }
      }
    }, 60_000);

    it('delivers the entry as JSON, with a subject and code and source attributes', async () => {
      const topicArn: string = await createTopic(`${namePrefix}-plain`, false);
      const queueUrl: string = await subscribeQueue(
        `${namePrefix}-plain`,
        topicArn
      );
      const adapter = new SnsErrorAdapter(sns, topicArn);
      const id: string = crypto.randomUUID();

      const result = await adapter.log({
        id,
        code: 'LIVE_TEST',
        message: 'one message per entry',
        source: 'live-test',
        cause: new Error('boom'),
        timestamp: '2026-01-02T03:04:05.678Z',
      });

      expect(result).toEqual({ ok: true });
      const [envelope] = await receive(queueUrl, 1);
      expect(envelope?.Subject).toBe('LIVE_TEST: one message per entry');
      expect(JSON.parse(envelope?.Message ?? '{}')).toMatchObject({
        id,
        code: 'LIVE_TEST',
        message: 'one message per entry',
        source: 'live-test',
        timestamp: '2026-01-02T03:04:05.678Z',
        cause: { name: 'Error', message: 'boom' },
      });
      expect(envelope?.MessageAttributes?.['code']?.Value).toBe('LIVE_TEST');
      expect(envelope?.MessageAttributes?.['source']?.Value).toBe('live-test');
    }, 90_000);

    it('lets a subscription filter policy pick entries by code', async () => {
      const topicArn: string = await createTopic(`${namePrefix}-filter`, false);
      const allQueue: string = await subscribeQueue(
        `${namePrefix}-filter-all`,
        topicArn
      );
      const keepQueue: string = await subscribeQueue(
        `${namePrefix}-filter-keep`,
        topicArn,
        { filterPolicy: { code: ['KEEP'] } }
      );
      const adapter = new SnsErrorAdapter(sns, topicArn);

      expect(await adapter.log({ code: 'KEEP', message: 'wanted' })).toEqual({
        ok: true,
      });
      expect(await adapter.log({ code: 'DROP', message: 'unwanted' })).toEqual({
        ok: true,
      });

      const all = await receive(allQueue, 2);
      expect(
        all.map((envelope) => JSON.parse(envelope.Message).code).sort()
      ).toEqual(['DROP', 'KEEP']);
      const kept = await receive(keepQueue, 1);
      expect(kept).toHaveLength(1);
      expect(JSON.parse(kept[0]?.Message ?? '{}').code).toBe('KEEP');
      // The unwanted entry would have arrived by now; make sure it did not.
      expect(await receive(keepQueue, 1, 4)).toHaveLength(0);
    }, 90_000);

    it('drops a repeat of the same entry id on a FIFO topic', async () => {
      const topicArn: string = await createTopic(`${namePrefix}-fifo`, true);
      const queueUrl: string = await subscribeQueue(
        `${namePrefix}-fifo`,
        topicArn,
        { fifo: true }
      );
      const adapter = new SnsErrorAdapter(sns, topicArn, {
        messageGroupId: 'live-test',
      });
      const id: string = crypto.randomUUID();
      const entry = { id, code: 'LIVE_TEST', message: 'retry me' };

      expect(await adapter.log(entry)).toEqual({ ok: true });
      expect(await adapter.log(entry)).toEqual({ ok: true });

      const received = await receive(queueUrl, 2, 10);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]?.Message ?? '{}').id).toBe(id);
    }, 90_000);

    it('returns a descriptive failure for a topic that does not exist', async () => {
      const existing: string = await createTopic(`${namePrefix}-exists`, false);
      const missingArn = `${existing}-missing`;
      const adapter = new SnsErrorAdapter(sns, missingArn);

      const originalConsoleError = console.error;
      console.error = () => {};
      const result = await adapter.log({ code: 'LIVE_TEST', message: 'nope' });
      console.error = originalConsoleError;

      expect(result.ok).toBe(false);
      expect(result.error).toContain(`topic "${missingArn}"`);
    }, 60_000);
  }
);
