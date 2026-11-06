/**
 * Live test for the chat formatters against real incoming webhooks. Each part is
 * skipped unless its URL is set, so `bun run test` and CI never post anything.
 * Every part posts real messages to the channel the URL belongs to: use a test
 * channel.
 *
 *   SLACK_WEBHOOK_TEST_URL=https://hooks.slack.com/services/...
 *   GOOGLE_CHAT_WEBHOOK_TEST_URL=https://chat.googleapis.com/v1/spaces/...
 *   DISCORD_WEBHOOK_TEST_URL=https://discord.com/api/webhooks/...
 *   TEAMS_WEBHOOK_TEST_URL=https://...logic.azure.com/... (a Workflows webhook)
 *
 * Run it with `bun run test:live`, then look at each channel: there should be
 * one message with a code block and one summarizing three errors, and none of
 * them should ping anyone.
 */
import { describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import { WebhookErrorAdapter } from './webhook-error-adapter.js';
import {
  formatDiscordBody,
  formatGoogleChatBody,
  formatSlackBody,
  formatTeamsBody,
} from './webhook-formatters.js';
import type { WebhookBodyFormatter } from './webhook-formatters.js';

const SERVICES: {
  name: string;
  url: string | undefined;
  formatBody: WebhookBodyFormatter;
}[] = [
  {
    name: 'Slack',
    url: process.env['SLACK_WEBHOOK_TEST_URL'],
    formatBody: formatSlackBody,
  },
  {
    name: 'Google Chat',
    url: process.env['GOOGLE_CHAT_WEBHOOK_TEST_URL'],
    formatBody: formatGoogleChatBody,
  },
  {
    name: 'Discord',
    url: process.env['DISCORD_WEBHOOK_TEST_URL'],
    formatBody: formatDiscordBody,
  },
  {
    name: 'Teams',
    url: process.env['TEAMS_WEBHOOK_TEST_URL'],
    formatBody: formatTeamsBody,
  },
];

function entry(
  message: string,
  extra: Partial<ErrorLogEntry> = {}
): ErrorLogEntry {
  return {
    code: 'LIVE_TEST',
    message,
    source: 'error-log-adapter live test',
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

for (const { name, url, formatBody } of SERVICES) {
  describe.skipIf(url === undefined)(`${name} webhook formatter`, () => {
    const adapter = (): WebhookErrorAdapter =>
      new WebhookErrorAdapter(url ?? 'https://example.com/unused', {
        formatBody,
        retries: 2,
      });

    it('accepts one entry with a cause and awkward text', async () => {
      const result = await adapter().log(
        entry(
          'Mentions must not ping: @channel @here @everyone <!channel> <users/all> & < >',
          {
            cause: Object.assign(new Error('outer failure'), {
              cause: new Error('inner failure with ``` backticks ```'),
            }),
          }
        )
      );

      expect(result).toEqual({ ok: true });
    });

    it('accepts a very long cause, cut to fit', async () => {
      const result = await adapter().log(
        entry('A cause far longer than the service allows', {
          cause: 'line of stack trace\n'.repeat(5000),
        })
      );

      expect(result).toEqual({ ok: true });
    });

    it('accepts a batch as one summary message', async () => {
      const result = await adapter().logBatch([
        entry('first of three'),
        entry('second of three'),
        entry('third of three'),
      ]);

      expect(result).toEqual({ ok: true });
    });
  });
}
