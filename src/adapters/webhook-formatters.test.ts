import { describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '../types.js';
import {
  formatDiscordBody,
  formatGoogleChatBody,
  formatSlackBody,
  formatTeamsBody,
} from './webhook-formatters.js';

const ENTRY: ErrorLogEntry = {
  code: 'PAYMENT_FAILED',
  message: 'card was declined',
  source: 'checkout',
  timestamp: '2026-01-02T03:04:05.000Z',
};

function manyEntries(count: number): ErrorLogEntry[] {
  return Array.from({ length: count }, (_value: unknown, index: number) => ({
    code: `E${index}`,
    message: `failure number ${index}`,
    timestamp: '2026-01-02T03:04:05.000Z',
  }));
}

const CHAT_FORMATTERS: {
  name: string;
  format: (entries: ErrorLogEntry[]) => string;
  maxLength: number;
  bold: (text: string) => string;
}[] = [
  {
    name: 'Slack',
    format: (entries: ErrorLogEntry[]): string => formatSlackBody(entries).text,
    maxLength: 4000,
    bold: (text: string): string => `*${text}*`,
  },
  {
    name: 'Google Chat',
    format: (entries: ErrorLogEntry[]): string =>
      formatGoogleChatBody(entries).text,
    maxLength: 4096,
    bold: (text: string): string => `*${text}*`,
  },
  {
    name: 'Discord',
    format: (entries: ErrorLogEntry[]): string =>
      formatDiscordBody(entries).content,
    maxLength: 2000,
    bold: (text: string): string => `**${text}**`,
  },
];

describe.each(CHAT_FORMATTERS)(
  '$name text',
  ({ format, maxLength, bold }): void => {
    it('puts the code and message first, then the source and time', () => {
      const text: string = format([ENTRY]);

      expect(text.split('\n')).toEqual([
        `${bold('PAYMENT_FAILED')}: card was declined`,
        'checkout · 2026-01-02T03:04:05.000Z',
      ]);
    });

    it('leaves out the source when there is none', () => {
      const text: string = format([{ ...ENTRY, source: undefined }]);

      expect(text.split('\n')[1]).toBe('2026-01-02T03:04:05.000Z');
    });

    it('puts an error cause in a code block, stack first', () => {
      const cause = new Error('connection reset');

      const text: string = format([{ ...ENTRY, cause }]);

      expect(text).toContain('\n```\nError: connection reset\n    at ');
      expect(text.endsWith('\n```')).toBe(true);
    });

    it('lists each cause below the first', () => {
      const cause: Error = Object.assign(new Error('outer'), {
        cause: new Error('inner'),
      });

      const text: string = format([{ ...ENTRY, cause }]);

      expect(text).toContain('Caused by: Error: inner');
    });

    it('writes a cause that is not an error as text or JSON', () => {
      expect(format([{ ...ENTRY, cause: 'plain reason' }])).toContain(
        '\n```\nplain reason\n```'
      );
      expect(format([{ ...ENTRY, cause: { status: 402 } }])).toContain(
        '"status": 402'
      );
    });

    it('survives a circular cause', () => {
      const cause: Record<string, unknown> = { name: 'loop' };
      cause['self'] = cause;

      const text: string = format([{ ...ENTRY, cause }]);

      expect(text).toContain('[Circular]');
    });

    it('keeps a run of backticks in the cause from closing the code block', () => {
      const text: string = format([
        { ...ENTRY, cause: 'before ``` after ``` end' },
      ]);

      expect(text.split('```')).toHaveLength(3);
    });

    it('cuts a long cause to fit and says so', () => {
      const text: string = format([{ ...ENTRY, cause: 'x'.repeat(50_000) }]);

      expect(text.length).toBeLessThanOrEqual(maxLength);
      expect(text).toContain('… (truncated)\n```');
      expect(text.startsWith(bold('PAYMENT_FAILED'))).toBe(true);
    });

    it('cuts a very long message to fit', () => {
      const text: string = format([
        { ...ENTRY, message: 'm'.repeat(50_000), cause: new Error('why') },
      ]);

      expect(text.length).toBeLessThanOrEqual(maxLength);
      expect(text).toContain('… (truncated)');
    });

    it('does not cut an emoji in half', () => {
      const text: string = format([
        { ...ENTRY, message: '😀'.repeat(maxLength) },
      ]);

      expect(text.length).toBeLessThanOrEqual(maxLength);
      expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    });

    it('summarizes several entries in one message', () => {
      const text: string = format(manyEntries(3));

      expect(text.split('\n')).toEqual([
        bold('3 errors'),
        `• ${bold('E0')}: failure number 0 (2026-01-02T03:04:05.000Z)`,
        `• ${bold('E1')}: failure number 1 (2026-01-02T03:04:05.000Z)`,
        `• ${bold('E2')}: failure number 2 (2026-01-02T03:04:05.000Z)`,
      ]);
    });

    it('stops a long list at the limit and counts the rest', () => {
      const text: string = format(manyEntries(500));

      expect(text.length).toBeLessThanOrEqual(maxLength);
      expect(text).toMatch(/\n… and \d+ more$/);
      const shown: number = text
        .split('\n')
        .filter((line: string): boolean => line.startsWith('• ')).length;
      const hidden = Number(/and (\d+) more$/.exec(text)?.[1]);
      expect(shown + hidden).toBe(500);
    });

    it('fills in a timestamp when the entry has none', () => {
      const text: string = format([{ ...ENTRY, timestamp: undefined }]);

      expect(text).toMatch(/checkout · \d{4}-\d\d-\d\dT/);
    });
  }
);

describe('formatSlackBody', () => {
  it('returns the { text } message Slack expects', () => {
    expect(Object.keys(formatSlackBody([ENTRY]))).toEqual(['text']);
  });

  it('escapes &, < and > so an error cannot mention @channel', () => {
    const { text } = formatSlackBody([
      { ...ENTRY, message: '<!channel> a & b <https://x.test|click>' },
    ]);

    expect(text).toContain(
      '&lt;!channel&gt; a &amp; b &lt;https://x.test|click&gt;'
    );
    expect(text).not.toContain('<!channel>');
  });

  it('escapes the cause too', () => {
    const { text } = formatSlackBody([
      { ...ENTRY, cause: 'bad <!here> input' },
    ]);

    expect(text).toContain('bad &lt;!here&gt; input');
  });
});

describe('formatGoogleChatBody', () => {
  it('returns the { text } message Google Chat expects', () => {
    expect(Object.keys(formatGoogleChatBody([ENTRY]))).toEqual(['text']);
  });

  it('makes <users/all> and links harmless', () => {
    const { text } = formatGoogleChatBody([
      { ...ENTRY, message: 'hey <users/all> see <https://x.test|here>' },
    ]);

    expect(text).not.toContain('<users/all>');
    expect(text).not.toContain('<https://');
    expect(text).toContain('users/all');
  });
});

describe('formatDiscordBody', () => {
  it('returns content and switches every mention off', () => {
    const body = formatDiscordBody([
      { ...ENTRY, message: '@everyone <@&123> look' },
    ]);

    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain('@everyone <@&123> look');
  });
});

describe('formatTeamsBody', () => {
  function texts(entries: ErrorLogEntry[]): string[] {
    return formatTeamsBody(entries).attachments[0]?.content.body.map(
      (block): string => block.text
    ) as string[];
  }

  it('returns a message carrying one Adaptive Card', () => {
    const body = formatTeamsBody([ENTRY]);

    expect(body.type).toBe('message');
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
      },
    });
  });

  it('shows the heading, the details and the cause in monospace', () => {
    const body = formatTeamsBody([{ ...ENTRY, cause: new Error('boom') }]);

    const blocks = body.attachments[0]?.content.body ?? [];
    expect(blocks.map((block) => block.text.split('\n')[0])).toEqual([
      'PAYMENT_FAILED: card was declined',
      'checkout · 2026-01-02T03:04:05.000Z',
      'Error: boom',
    ]);
    expect(blocks[0]).toMatchObject({ weight: 'Bolder', wrap: true });
    expect(blocks[2]).toMatchObject({ fontType: 'Monospace', wrap: true });
  });

  it('has no cause block without a cause', () => {
    expect(texts([ENTRY])).toHaveLength(2);
  });

  it('cuts a long cause', () => {
    const cause: string = (
      texts([{ ...ENTRY, cause: 'x'.repeat(100_000) }])[2] as string
    ).toString();

    expect(cause.length).toBeLessThanOrEqual(8000);
    expect(cause.endsWith('… (truncated)')).toBe(true);
  });

  it('lists several entries on one card, up to 50', () => {
    const lines: string[] = texts(manyEntries(60));

    expect(lines[0]).toBe('60 errors');
    expect(lines).toHaveLength(1 + 50 + 1);
    expect(lines.at(-1)).toBe('… and 10 more');
  });
});
