# @richardmcquiston01/error-log-adapter-google-sheets

A [Google Sheets](https://workspace.google.com/products/sheets/) adapter for [`@richardmcquiston01/error-log-adapter`](../../README.md). It appends each error as a row in a spreadsheet tab, through the official Google Sheets client, so a team can read, filter and share the errors without any tooling.

**Sheets is a shared notebook, not a log store.** It allows only about 60 writes per minute per user and 10 million cells per spreadsheet (about 1.6 million rows of these six columns). Put a [`BatchingErrorAdapter`](../../README.md) in front of it so many errors become one request, and keep an eye on the sheet's size. For heavy traffic use a database adapter and keep Sheets for a readable copy of what matters.

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-google-sheets @googleapis/sheets
```

`@googleapis/sheets` is only the Sheets part of Google's client. The all-in-one `googleapis` package works too.

## Set up the spreadsheet

1. Create a Google Cloud project, turn on the **Google Sheets API**, and create a **service account** with a JSON key.
2. Create a spreadsheet with a tab named `error_log` (or choose another name with `sheetName`).
3. **Share the spreadsheet** with the service account's email address (it ends in `.iam.gserviceaccount.com`) as an **Editor**.
4. Copy the spreadsheet ID: the long part of its URL between `/d/` and `/edit`.

## Usage

```ts
import { auth, sheets } from '@googleapis/sheets';
import { BatchingErrorAdapter } from '@richardmcquiston01/error-log-adapter';
import { GoogleSheetsErrorAdapter } from '@richardmcquiston01/error-log-adapter-google-sheets';

const client = sheets({
  version: 'v4',
  // Reads the key file named by GOOGLE_APPLICATION_CREDENTIALS.
  auth: new auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  }),
});

const adapter = new BatchingErrorAdapter(
  new GoogleSheetsErrorAdapter(client, process.env.ERROR_SHEET_ID ?? '', {
    writeHeader: true,
  }),
  { batchSize: 20, maxWaitMs: 30_000 }
);

const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

## What is stored

One row per entry, in these columns (the names are written into the first row when `writeHeader` is on):

| Column        | Holds                                                                          |
| ------------- | ------------------------------------------------------------------------------ |
| `id`          | The entry's UUID                                                               |
| `occurred_at` | The entry's time, as ISO 8601 text such as `2026-10-19T05:00:00.123Z`          |
| `code`        | The error code                                                                 |
| `message`     | The message                                                                    |
| `source`      | The source, or empty                                                           |
| `cause`       | The cause as JSON text (an error becomes `name`, `message`, `stack`), or empty |

Rows are added with `insertDataOption: INSERT_ROWS` below the last row of the tab, and the values are sent as **`RAW`**, so Sheets stores them exactly as written. A message that starts with `=`, `+`, `-` or `@` is stored as text and never runs as a formula.

A cell holds at most 50,000 characters. A longer message, source or cause is cut and ends with `… (truncated)`.

## The header row

Turn on `writeHeader` to write the column names into the first row, on first use, **only when that row is empty**. A first row that already has something in it is never changed, so you can keep your own headings (the columns must still be in the order above). Two processes starting at the same moment on an empty tab can both write it. The names are also exported as `SHEET_COLUMNS` and `buildSheetHeaderRow()` if you would rather paste them yourself.

## Repeats

An append cannot tell that a row is already there. If `log` times out and you try the same entry again, the first attempt may have succeeded and you will get a second row. The `id` column makes a repeat easy to spot and delete.

## Options

| Option        | Default               | Meaning                                                            |
| ------------- | --------------------- | ------------------------------------------------------------------ |
| `sheetName`   | `error_log`           | The tab to append to. It must already exist.                       |
| `writeHeader` | `false`               | Write the column names into an empty first row on first use.       |
| `timeoutMs`   | `10000`               | How long to wait for each request. `Infinity` waits without limit. |
| `prefix`      | `[error-log-adapter]` | Text printed before failure messages.                              |

The constructor is `new GoogleSheetsErrorAdapter(client, spreadsheetId, options)`. An empty spreadsheet ID or tab name throws a `RangeError`.

## Failures

`log` never throws. It returns `{ ok: false, error }` and the message says what to do for the failures people hit most:

- **429**: Sheets' write quota. The message points at `BatchingErrorAdapter`.
- **403**: the signed-in account cannot edit the spreadsheet. Share it with the service account's email as an Editor, and check that the Sheets API is enabled.
- **404**: the spreadsheet was not found. Check the ID.
- **400, "Unable to parse range"**: the tab does not exist. The message names the tab.

Google's own text is kept in the message too.

## Batching

`logBatch` appends every entry in **one request**, so `BatchingErrorAdapter` can wrap this adapter and stay well inside the write quota. It checks every entry first and writes nothing if one is invalid (a bad `id`). The request is one write: Sheets adds all of its rows or none.

## What was checked

- Unit tests with a fake client (rows, quoting of tab names, the cell limit, the header, batching with `BatchingErrorAdapter`, the failure messages and timeouts), and a compile-time check that the real `@googleapis/sheets` client type fits `SheetsClientLike`.
- **Not run against a real spreadsheet yet.** An opt-in live test (`google-sheets-error-adapter.live.test.ts`) is included: set `GOOGLE_SHEETS_TEST_SPREADSHEET_ID` and `GOOGLE_APPLICATION_CREDENTIALS` (see the top of that file) and run `bun run test:live`. It adds a temporary tab for each check and deletes it afterwards.
- Not tested: OAuth user credentials (only a service account was in mind), very large batches, shared drives, and spreadsheets with protected ranges.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency. The client type is checked against `@googleapis/sheets` 18.
