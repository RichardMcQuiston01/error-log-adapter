import type {
  ErrorLogAdapter,
  ErrorLogEntry,
  ErrorLogResult,
} from '@richardmcquiston01/error-log-adapter';
import { serializeEntry } from '@richardmcquiston01/error-log-adapter';
import {
  DEFAULT_PREFIX,
  describeError,
  reportFailure,
  resolveEntryId,
  resolveTimeoutMs,
  timeoutMessage,
  withTimeout,
} from '@richardmcquiston01/error-log-adapter/kit';

/** The tab entries go to unless `sheetName` says otherwise. */
export const DEFAULT_SHEET_NAME = 'error_log';

/** The columns of a row, in order. The first row of the tab can hold these names. */
export const SHEET_COLUMNS = [
  'id',
  'occurred_at',
  'code',
  'message',
  'source',
  'cause',
] as const;

/** Google Sheets refuses a cell of more than 50,000 characters. */
export const MAX_CELL_LENGTH = 50_000;

const LAST_COLUMN = 'F';
const TRUNCATION_MARKER = '… (truncated)';

export interface SheetsAppendParamsLike {
  spreadsheetId: string;
  range: string;
  valueInputOption: 'RAW';
  insertDataOption: 'INSERT_ROWS';
  requestBody: { values: string[][] };
}

export interface SheetsGetParamsLike {
  spreadsheetId: string;
  range: string;
}

export interface SheetsUpdateParamsLike {
  spreadsheetId: string;
  range: string;
  valueInputOption: 'RAW';
  requestBody: { values: string[][] };
}

/** The part of a Sheets `ValueRange` response this adapter reads. */
export interface SheetsValueRangeLike {
  values?: unknown[][] | null;
}

/** `spreadsheets.values` of the Sheets API, reduced to the three calls used here. */
export interface SheetsValuesLike {
  append(params: SheetsAppendParamsLike): Promise<unknown>;
  get(params: SheetsGetParamsLike): Promise<{ data: SheetsValueRangeLike }>;
  update(params: SheetsUpdateParamsLike): Promise<unknown>;
}

/**
 * What this adapter needs from a Google Sheets client: `spreadsheets.values`
 * with `append`, plus `get` and `update` (used only to write the header row).
 * The client from `@googleapis/sheets` or `googleapis`
 * (`sheets({ version: 'v4', auth })`) fits as it is.
 */
export interface SheetsClientLike {
  spreadsheets: { values: SheetsValuesLike };
}

export interface GoogleSheetsErrorOptions {
  /** Tab to append to. Defaults to `error_log`. The tab must already exist. */
  sheetName?: string;
  /**
   * Write the column names (see `SHEET_COLUMNS`) into the first row on first
   * use, but only when that row is empty. An existing first row is never
   * changed. Defaults to `false`: create the header yourself, or turn this on.
   * Two processes starting at the same moment on an empty tab can both write it.
   */
  writeHeader?: boolean;
  /** Text printed before failure messages. Defaults to `[error-log-adapter]`. */
  prefix?: string;
  /**
   * How long `log` waits for each Sheets request, in milliseconds. Defaults to
   * 10000. Pass `Infinity` to wait without limit. The request cannot be
   * cancelled, so it may still finish after `log` has returned a failure.
   */
  timeoutMs?: number;
}

/** The header row: `SHEET_COLUMNS` as one row of values. */
export function buildSheetHeaderRow(): string[] {
  return [...SHEET_COLUMNS];
}

/** `'my tab'!A:F`: the tab name quoted, with any `'` in it doubled. */
function rangeFor(sheetName: string, cells: string): string {
  return `'${sheetName.split("'").join("''")}'!${cells}`;
}

/** Cuts a cell to the limit Sheets allows, ending with a marker when it was cut. */
function fitCell(text: string): string {
  if (text.length <= MAX_CELL_LENGTH) {
    return text;
  }
  let end: number = MAX_CELL_LENGTH - TRUNCATION_MARKER.length;
  const last: number = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    // Do not leave half of a surrogate pair at the cut.
    end -= 1;
  }
  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}

/** The HTTP status carried by an error from the Google client, whichever field it used. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [
    candidate.code,
    candidate.status,
    candidate.response?.status,
  ]) {
    const status: number =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : NaN;
    if (Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  }
  return undefined;
}

/** The error's own message, with a hint added for the failures people hit most. */
function describeSheetsError(error: unknown, sheetName: string): string {
  const message: string = describeError(error);
  switch (statusOf(error)) {
    case 429:
      return `${message} (Google Sheets allows only about 60 writes per minute per user, so this adapter is being called too often; wrap it in a BatchingErrorAdapter to send many entries in one request)`;
    case 403:
      return `${message} (the account the client signs in as cannot edit this spreadsheet: share it with that account, a service account's email address, as an Editor, and make sure the Google Sheets API is enabled for the project)`;
    case 404:
      return `${message} (spreadsheet not found: check the spreadsheet ID, which is the long part of its URL between /d/ and /edit)`;
    case 400:
      return /unable to parse range/i.test(message)
        ? `${message} (the spreadsheet has no tab named "${sheetName}": create it, or set sheetName)`
        : message;
    default:
      return message;
  }
}

/**
 * Appends each entry as a row in a Google Sheets tab: `id`, `occurred_at`,
 * `code`, `message`, `source` and `cause` (the cause as JSON text). It writes
 * through `spreadsheets.values.append` with `RAW` input, so a message that
 * starts with `=` is stored as text and never runs as a formula.
 *
 * Sheets is not built for volume. It allows about 60 writes per minute per user
 * and 10 million cells per spreadsheet (about 1.6 million rows of these six
 * columns), so put a `BatchingErrorAdapter` in front of it: `logBatch` appends a
 * whole batch in one request. A cell holds at most 50,000 characters, so a
 * longer message or cause is cut and says so.
 *
 * An append cannot detect a repeat. A retry of the same entry, such as after a
 * timeout, can add a second row; the `id` column lets you spot and delete it.
 */
export class GoogleSheetsErrorAdapter<
  TCode extends string = string,
> implements ErrorLogAdapter<TCode> {
  private readonly sheetName: string;
  private readonly writeHeader: boolean;
  private readonly logPrefix: string;
  private readonly timeoutMs: number;
  private headerReady: Promise<void> | null = null;

  /** @throws {RangeError} if `spreadsheetId` or `sheetName` is empty, or `timeoutMs` is invalid. */
  constructor(
    private readonly client: SheetsClientLike,
    private readonly spreadsheetId: string,
    options: GoogleSheetsErrorOptions = {}
  ) {
    if (spreadsheetId.trim() === '') {
      throw new RangeError(
        'GoogleSheetsErrorAdapter: spreadsheetId must not be empty. It is the long part of the spreadsheet URL between /d/ and /edit.'
      );
    }
    this.sheetName = options.sheetName ?? DEFAULT_SHEET_NAME;
    if (this.sheetName.trim() === '') {
      throw new RangeError(
        'GoogleSheetsErrorAdapter: sheetName must not be empty; leave it out to use "error_log".'
      );
    }
    this.writeHeader = options.writeHeader ?? false;
    this.logPrefix = options.prefix ?? DEFAULT_PREFIX;
    this.timeoutMs = resolveTimeoutMs(
      options.timeoutMs,
      'GoogleSheetsErrorAdapter'
    );
  }

  async log(entry: ErrorLogEntry<TCode>): Promise<ErrorLogResult> {
    try {
      const row: string[] = this.toRow(entry);
      await this.ensureHeader();
      await this.append([row]);
      return { ok: true };
    } catch (error: unknown) {
      return this.failed(`to append to tab "${this.sheetName}"`, error);
    }
  }

  /**
   * Appends several entries in one request, which `BatchingErrorAdapter` uses
   * when it wraps this adapter. Every entry is checked first, so one that cannot
   * be stored (an invalid `id`) fails the whole call and nothing is written. The
   * request is one write: Sheets adds all of its rows or none.
   */
  async logBatch(entries: ErrorLogEntry<TCode>[]): Promise<ErrorLogResult> {
    if (entries.length === 0) {
      return { ok: true };
    }
    const count: number = entries.length;
    try {
      const rows: string[][] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          rows.push(this.toRow(entry));
        } catch (error: unknown) {
          throw new Error(
            `${describeError(error)} (entry ${index} could not be prepared, so nothing was written)`
          );
        }
      }
      await this.ensureHeader();
      await this.append(rows);
      return { ok: true };
    } catch (error: unknown) {
      return this.failed(
        `to append ${count} entr${count === 1 ? 'y' : 'ies'} to tab "${this.sheetName}"`,
        error
      );
    }
  }

  private failed(action: string, error: unknown): ErrorLogResult {
    const reason: string = describeSheetsError(error, this.sheetName);
    return reportFailure({
      adapterName: 'GoogleSheetsErrorAdapter',
      prefix: this.logPrefix,
      action,
      // An error from Google carries the whole request (the URL with the
      // spreadsheet ID, and the row being written) and prints a page long, so the
      // console gets the short reason instead. Other errors are printed as they are.
      error: statusOf(error) === undefined ? error : reason,
      reason,
    });
  }

  private toRow(entry: ErrorLogEntry<TCode>): string[] {
    const serialized = serializeEntry(entry);
    return [
      resolveEntryId(entry),
      serialized.timestamp,
      serialized.code,
      fitCell(serialized.message),
      fitCell(serialized.source ?? ''),
      serialized.cause === undefined
        ? ''
        : fitCell(JSON.stringify(serialized.cause)),
    ];
  }

  /** Writes the header once, when asked to and the first row is empty. A failed attempt is retried on the next call. */
  private ensureHeader(): Promise<void> {
    if (!this.writeHeader) {
      return Promise.resolve();
    }
    if (this.headerReady === null) {
      this.headerReady = this.writeHeaderIfEmpty().then(
        (): void => undefined,
        (error: unknown): never => {
          this.headerReady = null;
          throw error;
        }
      );
    }
    return this.headerReady;
  }

  private async writeHeaderIfEmpty(): Promise<void> {
    const range: string = rangeFor(this.sheetName, `A1:${LAST_COLUMN}1`);
    const existing = await withTimeout(
      (): Promise<{ data: SheetsValueRangeLike }> =>
        this.client.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId,
          range,
        }),
      this.timeoutMs,
      timeoutMessage('Google Sheets', this.timeoutMs)
    );
    const firstRow: unknown[] | undefined = existing.data.values?.[0];
    if (firstRow !== undefined && firstRow.length > 0) {
      return;
    }
    await withTimeout(
      (): Promise<unknown> =>
        this.client.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range,
          valueInputOption: 'RAW',
          requestBody: { values: [buildSheetHeaderRow()] },
        }),
      this.timeoutMs,
      timeoutMessage('Google Sheets', this.timeoutMs)
    );
  }

  private async append(rows: string[][]): Promise<void> {
    await withTimeout(
      (): Promise<unknown> =>
        this.client.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: rangeFor(this.sheetName, `A:${LAST_COLUMN}`),
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: rows },
        }),
      this.timeoutMs,
      timeoutMessage('Google Sheets', this.timeoutMs)
    );
  }
}
