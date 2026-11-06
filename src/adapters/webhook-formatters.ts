import { serializeCause, MAX_CAUSE_DEPTH } from '../serialize.js';
import type { ErrorLogEntry } from '../types.js';

/**
 * Builds the JSON body `WebhookErrorAdapter` sends, from the entries in one
 * request: one entry for `log`, several for `logBatch`. Pass it as the
 * `formatBody` option. Return anything `JSON.stringify` can write.
 */
export type WebhookBodyFormatter = (entries: ErrorLogEntry[]) => unknown;

/** The shape of a chat service's message, so one layout serves all of them. */
interface ChatStyle {
  /** Most characters one message may hold. Longer text is cut, not refused. */
  maxLength: number;
  bold(text: string): string;
  /** Neutralizes text that the service would act on (mentions, links, markup). */
  escape(text: string): string;
}

const TRUNCATION_MARKER = '… (truncated)';
/** Stops a stray run of backticks from closing a code block early. */
const ZERO_WIDTH_SPACE = '​';
const MAX_LINE_LENGTH = 200;

/** Cuts `text` to at most `max` characters, ending with a marker when it was cut. */
function truncateText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= TRUNCATION_MARKER.length) {
    return text.slice(0, Math.max(0, max));
  }
  let end: number = max - TRUNCATION_MARKER.length;
  const last: number = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    // Do not leave half of a surrogate pair at the cut.
    end -= 1;
  }
  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}

function breakCodeFences(text: string): string {
  return text.split('```').join(`\`${ZERO_WIDTH_SPACE}\`\``);
}

function isSerializedError(value: unknown): value is {
  name: string;
  message: string;
  stack?: unknown;
  cause?: unknown;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { name?: unknown; message?: unknown };
  return (
    typeof candidate.name === 'string' && typeof candidate.message === 'string'
  );
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The cause as plain text: an error's stack, then each `cause` below it. */
function describeCause(cause: unknown): string | undefined {
  if (cause === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  let current: unknown = serializeCause(cause);
  for (
    let depth = 0;
    depth <= MAX_CAUSE_DEPTH && current !== undefined;
    depth += 1
  ) {
    const prefix: string = depth === 0 ? '' : 'Caused by: ';
    if (!isSerializedError(current)) {
      lines.push(`${prefix}${stringifyValue(current)}`);
      break;
    }
    lines.push(
      `${prefix}${
        typeof current.stack === 'string' && current.stack !== ''
          ? current.stack
          : `${current.name}: ${current.message}`
      }`
    );
    current = current.cause;
  }
  return lines.join('\n');
}

function entryDetails(entry: ErrorLogEntry): string {
  const when: string = entry.timestamp ?? new Date().toISOString();
  return entry.source === undefined ? when : `${entry.source} · ${when}`;
}

/** One entry: a heading, a details line, and the cause in a code block that fits `maxLength`. */
function singleEntryText(entry: ErrorLogEntry, style: ChatStyle): string {
  const fenceCost = 9;
  const detailsLine: string = style.escape(entryDetails(entry));
  const headingBudget: number = Math.floor(style.maxLength / 2);
  const heading: string = `${style.bold(style.escape(entry.code))}: ${truncateText(
    style.escape(entry.message),
    headingBudget
  )}`;
  const head = `${heading}\n${detailsLine}`;
  const cause: string | undefined = describeCause(entry.cause);
  if (cause === undefined) {
    return truncateText(head, style.maxLength);
  }
  const room: number = style.maxLength - head.length - fenceCost;
  if (room < 40) {
    return truncateText(head, style.maxLength);
  }
  const body: string = truncateText(breakCodeFences(style.escape(cause)), room);
  return `${head}\n\`\`\`\n${body}\n\`\`\``;
}

/** Several entries: a count, then one line each, as many as fit. */
function manyEntriesText(entries: ErrorLogEntry[], style: ChatStyle): string {
  const header: string = style.bold(`${entries.length} errors`);
  const lines: string[] = [];
  let used: number = header.length;
  for (const entry of entries) {
    const line = `• ${style.bold(style.escape(entry.code))}: ${truncateText(
      style.escape(entry.message),
      MAX_LINE_LENGTH
    )} (${style.escape(entryDetails(entry))})`;
    const remaining: number = entries.length - lines.length - 1;
    const reserve: number = remaining > 0 ? 24 : 0;
    if (used + line.length + 1 + reserve > style.maxLength) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const hidden: number = entries.length - lines.length;
  if (hidden > 0) {
    lines.push(`… and ${hidden} more`);
  }
  return truncateText([header, ...lines].join('\n'), style.maxLength);
}

function chatText(entries: ErrorLogEntry[], style: ChatStyle): string {
  if (entries.length === 1) {
    return singleEntryText(entries[0] as ErrorLogEntry, style);
  }
  return manyEntriesText(entries, style);
}

/** Slack reads `&`, `<` and `>` as markup, so `<!channel>` in an error message would ping the channel. */
function escapeSlack(text: string): string {
  return text
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;');
}

/** Google Chat reads `<users/all>` and `<url|text>` as mentions and links. */
function escapeGoogleChat(text: string): string {
  return text.split('<').join(`<${ZERO_WIDTH_SPACE}`);
}

const SLACK_STYLE: ChatStyle = {
  // Slack truncates a message over 40,000 characters and advises staying near 4,000.
  maxLength: 4000,
  bold: (text: string): string => `*${text}*`,
  escape: escapeSlack,
};

const GOOGLE_CHAT_STYLE: ChatStyle = {
  // Google Chat refuses a text message over 4,096 characters.
  maxLength: 4000,
  bold: (text: string): string => `*${text}*`,
  escape: escapeGoogleChat,
};

const DISCORD_STYLE: ChatStyle = {
  // Discord refuses `content` over 2,000 characters.
  maxLength: 2000,
  bold: (text: string): string => `**${text}**`,
  // Mentions are switched off with `allowed_mentions` instead.
  escape: (text: string): string => text,
};

/**
 * Formats entries as a Slack incoming-webhook message (`{ text }`). The code and
 * message come first, then the source and time, then the cause (an error's
 * stack) in a code block. Text is cut to fit Slack, `&`, `<` and `>` are
 * escaped so an error message cannot mention `@channel`, and several entries
 * become one summary message.
 *
 * @experimental Checked against Slack's documented format, not yet against a live webhook.
 */
export function formatSlackBody(entries: ErrorLogEntry[]): { text: string } {
  return { text: chatText(entries, SLACK_STYLE) };
}

/**
 * Formats entries as a Google Chat incoming-webhook message (`{ text }`), laid
 * out like `formatSlackBody`. Text is cut to fit Google Chat, and `<` is made
 * harmless so an error message cannot mention `<users/all>` or add a link.
 *
 * @experimental Checked against Google Chat's documented format, not yet against a live webhook.
 */
export function formatGoogleChatBody(entries: ErrorLogEntry[]): {
  text: string;
} {
  return { text: chatText(entries, GOOGLE_CHAT_STYLE) };
}

/**
 * Formats entries as a Discord webhook message (`{ content, allowed_mentions }`),
 * laid out like `formatSlackBody`. Content is cut to Discord's 2,000-character
 * limit, and `allowed_mentions` is set so that `@everyone` or a role in an error
 * message notifies nobody.
 *
 * @experimental Checked against Discord's documented format, not yet against a live webhook.
 */
export function formatDiscordBody(entries: ErrorLogEntry[]): {
  content: string;
  allowed_mentions: { parse: string[] };
} {
  return {
    content: chatText(entries, DISCORD_STYLE),
    allowed_mentions: { parse: [] },
  };
}

const TEAMS_CAUSE_LIMIT = 8000;
const TEAMS_MESSAGE_LIMIT = 1000;
const TEAMS_MAX_ENTRIES = 50;

/** One Adaptive Card text block. */
interface TeamsTextBlock {
  type: 'TextBlock';
  text: string;
  wrap: true;
  weight?: 'Bolder';
  isSubtle?: boolean;
  fontType?: 'Monospace';
}

/**
 * Formats entries as the message a Microsoft Teams "Workflows" webhook expects:
 * an Adaptive Card with a bold heading, a details line and the cause in
 * monospace. Several entries become one card with a line each. Teams shows an
 * Adaptive Card's text as written, so nothing is escaped, and mentions in
 * Teams need an explicit entity that an error message cannot create.
 *
 * @experimental Checked against Microsoft's documented format, not yet against a live webhook.
 */
export function formatTeamsBody(entries: ErrorLogEntry[]): {
  type: 'message';
  attachments: {
    contentType: 'application/vnd.microsoft.card.adaptive';
    contentUrl: null;
    content: {
      $schema: string;
      type: 'AdaptiveCard';
      version: '1.4';
      body: TeamsTextBlock[];
    };
  }[];
} {
  const body: TeamsTextBlock[] = [];
  if (entries.length === 1) {
    const entry = entries[0] as ErrorLogEntry;
    body.push({
      type: 'TextBlock',
      text: `${entry.code}: ${truncateText(entry.message, TEAMS_MESSAGE_LIMIT)}`,
      wrap: true,
      weight: 'Bolder',
    });
    body.push({
      type: 'TextBlock',
      text: entryDetails(entry),
      wrap: true,
      isSubtle: true,
    });
    const cause: string | undefined = describeCause(entry.cause);
    if (cause !== undefined) {
      body.push({
        type: 'TextBlock',
        text: truncateText(cause, TEAMS_CAUSE_LIMIT),
        wrap: true,
        fontType: 'Monospace',
      });
    }
  } else {
    body.push({
      type: 'TextBlock',
      text: `${entries.length} errors`,
      wrap: true,
      weight: 'Bolder',
    });
    for (const entry of entries.slice(0, TEAMS_MAX_ENTRIES)) {
      body.push({
        type: 'TextBlock',
        text: `${entry.code}: ${truncateText(entry.message, MAX_LINE_LENGTH)} (${entryDetails(entry)})`,
        wrap: true,
      });
    }
    if (entries.length > TEAMS_MAX_ENTRIES) {
      body.push({
        type: 'TextBlock',
        text: `… and ${entries.length - TEAMS_MAX_ENTRIES} more`,
        wrap: true,
        isSubtle: true,
      });
    }
  }
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
        },
      },
    ],
  };
}
