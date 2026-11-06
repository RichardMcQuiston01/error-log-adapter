/**
 * Live test for GoogleSheetsErrorAdapter against a real spreadsheet. It is
 * skipped unless GOOGLE_SHEETS_TEST_SPREADSHEET_ID is set, so `bun run test` and
 * CI never touch Google.
 *
 * Use a spreadsheet you can throw rows away in, and a service account that is
 * shared on it as an Editor (with the Google Sheets API enabled for its project):
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *   GOOGLE_SHEETS_TEST_SPREADSHEET_ID=<the part of the URL between /d/ and /edit> \
 *   bun run test:live
 *
 * The test adds a tab named `error_log_live_test_<id>` for each part and deletes
 * it when it finishes. It never touches your other tabs.
 */
import { auth, sheets } from '@googleapis/sheets';
import type { sheets_v4 } from '@googleapis/sheets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorLogEntry } from '@richardmcquiston01/error-log-adapter';
import {
  GoogleSheetsErrorAdapter,
  MAX_CELL_LENGTH,
} from './google-sheets-error-adapter.js';

const spreadsheetId: string | undefined =
  process.env['GOOGLE_SHEETS_TEST_SPREADSHEET_ID'];
const isConfigured: boolean = spreadsheetId !== undefined;

const runId: string = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const createdTabs: Map<string, number> = new Map();

let client: sheets_v4.Sheets;

function entry(
  message: string,
  extra: Partial<ErrorLogEntry> = {}
): ErrorLogEntry {
  return {
    code: 'LIVE_TEST',
    message,
    source: 'error-log-adapter live test',
    ...extra,
  };
}

/** Adds an empty tab and remembers it so it can be deleted afterwards. */
async function createTab(name: string): Promise<string> {
  const tabName = `error_log_live_test_${runId}_${name}`;
  const response = await client.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId as string,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
  const sheetId: number | null | undefined =
    response.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) {
    throw new Error(`Google did not return an ID for the new tab ${tabName}`);
  }
  createdTabs.set(tabName, sheetId);
  return tabName;
}

/** Every value in the tab, as the sheet displays it. */
async function readTab(tabName: string): Promise<string[][]> {
  const response = await client.spreadsheets.values.get({
    spreadsheetId: spreadsheetId as string,
    range: `'${tabName}'!A:F`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  return (response.data.values ?? []) as string[][];
}

describe.skipIf(!isConfigured)(
  'GoogleSheetsErrorAdapter against a real spreadsheet',
  () => {
    beforeAll(() => {
      client = sheets({
        version: 'v4',
        auth: new auth.GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        }),
      });
    });

    afterAll(async () => {
      if (spreadsheetId === undefined || createdTabs.size === 0) {
        return;
      }
      await client.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [...createdTabs.values()].map((sheetId: number) => ({
            deleteSheet: { sheetId },
          })),
        },
      });
    });

    it('writes the header on an empty tab, then one row per entry', async () => {
      const tab = await createTab('rows');
      const adapter = new GoogleSheetsErrorAdapter(
        client,
        spreadsheetId as string,
        { sheetName: tab, writeHeader: true }
      );

      const first = await adapter.log(
        entry('cannot reach the database', {
          cause: new Error('ECONNREFUSED'),
          timestamp: '2026-10-19T05:00:00.123Z',
          id: '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
        })
      );
      const second = await adapter.log(entry('second entry'));

      expect([first, second]).toEqual([{ ok: true }, { ok: true }]);
      const rows = await readTab(tab);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual([
        'id',
        'occurred_at',
        'code',
        'message',
        'source',
        'cause',
      ]);
      expect(rows[1]?.slice(0, 5)).toEqual([
        '3f2b8c1e-5a7d-4e21-9c0a-1b2c3d4e5f60',
        '2026-10-19T05:00:00.123Z',
        'LIVE_TEST',
        'cannot reach the database',
        'error-log-adapter live test',
      ]);
      expect(JSON.parse(rows[1]?.[5] ?? '{}')).toMatchObject({
        name: 'Error',
        message: 'ECONNREFUSED',
      });
      expect(rows[2]?.[3]).toBe('second entry');
    });

    it('leaves a header you wrote yourself alone', async () => {
      const tab = await createTab('own_header');
      await client.spreadsheets.values.update({
        spreadsheetId: spreadsheetId as string,
        range: `'${tab}'!A1:C1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['mine', 'are', 'custom']] },
      });

      const result = await new GoogleSheetsErrorAdapter(
        client,
        spreadsheetId as string,
        { sheetName: tab, writeHeader: true }
      ).log(entry('after a custom header'));

      expect(result).toEqual({ ok: true });
      const rows = await readTab(tab);
      expect(rows[0]).toEqual(['mine', 'are', 'custom']);
      expect(rows[1]?.[3]).toBe('after a custom header');
    });

    it('stores text that looks like a formula as text', async () => {
      const tab = await createTab('formula');

      const result = await new GoogleSheetsErrorAdapter(
        client,
        spreadsheetId as string,
        { sheetName: tab }
      ).log(entry('=1+1'));

      expect(result).toEqual({ ok: true });
      expect((await readTab(tab))[0]?.[3]).toBe('=1+1');
    });

    it('appends a batch in one request, in order', async () => {
      const tab = await createTab('batch');

      const result = await new GoogleSheetsErrorAdapter(
        client,
        spreadsheetId as string,
        { sheetName: tab }
      ).logBatch([entry('one'), entry('two'), entry('three')]);

      expect(result).toEqual({ ok: true });
      expect((await readTab(tab)).map((row: string[]) => row[3])).toEqual([
        'one',
        'two',
        'three',
      ]);
    });

    it('adds every row when entries are logged at the same time', async () => {
      const tab = await createTab('concurrent');
      const adapter = new GoogleSheetsErrorAdapter(
        client,
        spreadsheetId as string,
        { sheetName: tab, writeHeader: true }
      );

      const results = await Promise.all(
        Array.from({ length: 5 }, (_unused: unknown, index: number) =>
          adapter.log(entry(`concurrent ${index}`))
        )
      );

      expect(results.every((result) => result.ok)).toBe(true);
      const rows = await readTab(tab);
      expect(rows).toHaveLength(6);
      expect(
        rows
          .slice(1)
          .map((row: string[]) => row[3])
          .sort()
      ).toEqual([
        'concurrent 0',
        'concurrent 1',
        'concurrent 2',
        'concurrent 3',
        'concurrent 4',
      ]);
    });

    it('cuts a cause longer than a cell can hold instead of failing', async () => {
      const tab = await createTab('long');

      const result = await new GoogleSheetsErrorAdapter(
        client,
        spreadsheetId as string,
        { sheetName: tab }
      ).log(
        entry('a very long cause', { cause: 'x'.repeat(MAX_CELL_LENGTH * 2) })
      );

      expect(result).toEqual({ ok: true });
      const cause = (await readTab(tab))[0]?.[5] ?? '';
      expect(cause).toHaveLength(MAX_CELL_LENGTH);
      expect(cause.endsWith('… (truncated)')).toBe(true);
    });

    it('says which tab is missing', async () => {
      const result = await new GoogleSheetsErrorAdapter(
        client,
        spreadsheetId as string,
        { sheetName: `error_log_live_test_${runId}_does_not_exist` }
      ).log(entry('nowhere to go'));

      expect(result.ok).toBe(false);
      expect(result.error).toContain('has no tab named');
    });

    it('fails clearly for a spreadsheet that does not exist', async () => {
      const result = await new GoogleSheetsErrorAdapter(
        client,
        '1111111111111111111111111111111111111111111'
      ).log(entry('no such spreadsheet'));

      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        'GoogleSheetsErrorAdapter failed to append'
      );
    });
  }
);
