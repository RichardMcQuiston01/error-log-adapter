# @richardmcquiston01/error-log-adapter-influxdb

[InfluxDB](https://www.influxdata.com) adapters for [`@richardmcquiston01/error-log-adapter`](../../README.md). Each error is written as one point of line protocol through the official client you create. This package has no runtime dependencies: the client is only needed by your application.

Two adapters, one for each client generation:

| Adapter                 | Takes                                                                                                                 | For                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `InfluxDbErrorAdapter`  | a `WriteApi` from [`@influxdata/influxdb-client`](https://www.npmjs.com/package/@influxdata/influxdb-client)          | InfluxDB 2.x and InfluxDB Cloud (TSM) |
| `InfluxDb3ErrorAdapter` | an `InfluxDBClient` from [`@influxdata/influxdb3-client`](https://www.npmjs.com/package/@influxdata/influxdb3-client) | InfluxDB 3 (Core, Enterprise, Cloud)  |

## Install

```sh
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-influxdb @influxdata/influxdb-client
# or, for InfluxDB 3:
npm install @richardmcquiston01/error-log-adapter @richardmcquiston01/error-log-adapter-influxdb @influxdata/influxdb3-client
```

## Usage

InfluxDB 2.x:

```ts
import { InfluxDB } from '@influxdata/influxdb-client';
import { InfluxDbErrorAdapter } from '@richardmcquiston01/error-log-adapter-influxdb';

const writeApi = new InfluxDB({ url, token }).getWriteApi(org, bucket, 'ns', {
  maxRetries: 0,
});
const adapter = new InfluxDbErrorAdapter(writeApi, { precision: 'ns' });
```

InfluxDB 3:

```ts
import { InfluxDBClient } from '@influxdata/influxdb3-client';
import { InfluxDb3ErrorAdapter } from '@richardmcquiston01/error-log-adapter-influxdb';

const client = new InfluxDBClient({ host, token, database: 'logs' });
const adapter = new InfluxDb3ErrorAdapter(client);
```

Then:

```ts
const result = await adapter.log({
  code: 'DB_DOWN',
  message: 'cannot reach the database',
  source: 'checkout',
});
if (!result.ok) {
  console.error(result.error);
}
```

**Match the precision.** A 2.x `WriteApi` is created with a precision (`getWriteApi(org, bucket, 'ns')`, which defaults to `ns`) and the adapter must write timestamps in the same unit, so pass the same value as `precision`. If they differ, every point is dated wrongly. The 3.x adapter sends its precision with each write, so it always matches.

## The point

```
error_log,code=DB_DOWN,source=checkout id="<uuid>",message="cannot reach the database",cause="<json>" <timestamp>
```

| Part            | Holds                                                          |
| --------------- | -------------------------------------------------------------- |
| measurement     | `error_log` (option `measurement`)                             |
| tag `code`      | `entry.code` (left out when empty)                             |
| tag `source`    | `entry.source` (left out when missing)                         |
| field `id`      | The entry's UUID                                               |
| field `message` | `entry.message`                                                |
| field `cause`   | The serialized cause, as a JSON string (left out when missing) |
| timestamp       | `entry.timestamp`                                              |

`code` and `source` are tags because they have few distinct values and you will filter and group by them. `id` is a field because a tag per UUID would create a series per error. Backslashes and line breaks in tags and the measurement are replaced (`\` with `/`, a line break with a space) because servers parse them inconsistently.

## Repeats and same-time errors

InfluxDB treats points with the same measurement, tags and timestamp as one point and keeps only the last. Two errors with the same `code` and `source` in the same millisecond would therefore overwrite each other. With `ns` or `us` precision (the default is `ns`) the adapter avoids this: the sub-millisecond part of the timestamp comes from the entry's `id`. The consequence is a useful one: **writing the same entry twice overwrites instead of duplicating**, so a retry is safe. The point's timestamp can differ from `entry.timestamp` by less than a millisecond. With `ms` or `s` precision there is no room for this, and entries with the same tags and time collide.

## Failures

Both adapters wait for the write to be accepted and return `ok: false` with the server's message when it is not (bad token, missing bucket, parse error, server down). This was checked with the real clients against a local stub server (see the tests): the 2.x `WriteApi.flush()` and the 3.x `write()` both reject on HTTP 400, 401 and 503. With the 2.x client set `maxRetries: 0` if you want a failure reported once; otherwise the client keeps retrying in the background, which is harmless here for the reason above.

## Options

| Option        | Adapter | Default               | Meaning                                                                   |
| ------------- | ------- | --------------------- | ------------------------------------------------------------------------- |
| `measurement` | both    | `error_log`           | Measurement name.                                                         |
| `precision`   | both    | `ns`                  | `ns`, `us`, `ms` or `s`. For 2.x it must match the write API's precision. |
| `database`    | 3.x     | the client's database | Database to write to.                                                     |
| `timeoutMs`   | both    | `10000`               | How long to wait for the write. `Infinity` waits without limit.           |
| `prefix`      | both    | `[error-log-adapter]` | Text printed before failure messages.                                     |

## Batching

Both adapters have `logBatch`, which writes a whole batch in one request, so `BatchingErrorAdapter` can wrap them. It checks every entry first and writes nothing if one is invalid.

## What was checked

- Unit tests with fakes, and the real clients against a local stub server (the 2.x `WriteApi.flush()` and the 3.x `write()` both reject on HTTP 400, 401 and 503). A compile-time check fits both real clients to the adapters' client types.
- An opt-in live test (`influxdb-error-adapter.live.test.ts`) ran against a real InfluxDB 2.9 server and a real InfluxDB 3 Core server in Docker. For both: the point's tags and fields, text with quotes, backslashes, commas, equals signs, spaces, line breaks and non-ASCII characters read back exactly as given, a repeated entry overwriting instead of duplicating, two errors with the same tags in the same millisecond staying separate, a batch in one request, and a failure coming back as `ok: false` (a rejected token and a missing bucket on 2.x, an unreachable server on 3). It is skipped unless `INFLUXDB_TEST_URL` or `INFLUXDB3_TEST_URL` is set; see the file for how to run it.
- Not tested: InfluxDB Cloud, InfluxDB 3 Enterprise or Cloud, a 3.x server with authentication on, and servers other than 2.9 and 3 Core.

## Compatibility

Requires `@richardmcquiston01/error-log-adapter` 0.15 or newer (the release that adds the `/kit` entry point) as a peer dependency.
