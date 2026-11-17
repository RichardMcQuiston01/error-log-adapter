# Export audit (1.0 readiness)

Every export of `@richardmcquiston01/error-log-adapter`, with a proposed label for 1.0. The core package has two entry points: `.` (the adapters) and `/kit` (helpers for adapter packages). The adapter packages under `packages/` are covered in the update near the end.

- **Stable:** covered by semver from 1.0. A breaking change needs a new major version.
- **Experimental:** exported and documented as experimental. It may change in a minor release, and the changelog says so. It moves to Stable once it meets the rule below.
- **Internal:** no longer exported, or exported but documented as unsupported.

**Rule for Stable.** An adapter is Stable when either of these holds:

1. It takes no outside client, and its unit tests exercise real behavior (the file system, Node's `EventEmitter`).
2. It takes a client, and the real client from the vendor's SDK is passed to it in a test that `tsc --noEmit` compiles in CI. That proves the hand-written `...Like` interface fits the real client, and it keeps fitting when the SDK changes.

An adapter whose only evidence is a fake client it was written against is Experimental. A fake can only agree with the interface it was written from.

**Decided.** `formatErrorLogLine` is no longer exported. Real-driver type tests (`src/adapters/real-driver-types.test.ts`) now cover the nine adapters listed as Experimental below, so all 21 adapters meet the rule and nothing is tagged `@experimental` at 1.0. The conditional `node:sqlite` test is accepted as enough for `SqliteErrorAdapter`. Both SQL setup function names stay for now; renaming one is breaking and is left for a decision before 1.0.0. The tables below show the state before this change.

**The `/kit` entry point.** `@richardmcquiston01/error-log-adapter/kit` re-exports internal helpers (`reportFailure`, `withTimeout`, `resolveEntryId` and others) for adapter packages. It is **Experimental** until the first adapter packages have shipped against it.

## What the evidence shows

- **All of 0.1.0 to 0.14.0 shipped between 2026-10-14 and 2026-10-18.** Fourteen tags in five days. No adapter has had time in other people's hands, so the rule above rests on tests, not on soak time.
- **The contract has barely changed.** Since 0.1.0 the only change to `ErrorLogEntry`, `ErrorLogResult` and `ErrorLogAdapter` is the optional `id` field. That makes the 1.0 contract safe to freeze.
- **CI never touches a real service.** The CI workflow runs lint, type checks, unit tests and the build, on Linux and on Windows. The opt-in live tests (CloudWatch Logs, Firestore, S3, SNS, Redis, MongoDB, and the MySQL and Postgres adapters) are run by hand with credentials. They also matter for rule 2: they pass the real SDK client straight into the adapter, so the type check in CI compiles that fit.
- **Most adapters have only fakes.** See the tiers below.

## Adapters

| Adapter                                     | Takes                            | Evidence                                                                                                                                 | Proposed                                                        |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `ConsoleErrorAdapter`                       | nothing                          | Unit tests. `chat-and-react` extends it                                                                                                  | Stable                                                          |
| `CompositeErrorAdapter`                     | other adapters                   | Unit tests with fake adapters. It has no client of its own                                                                               | Stable                                                          |
| `BatchingErrorAdapter`                      | another adapter                  | Unit tests                                                                                                                               | Stable                                                          |
| `EventEmitterErrorAdapter`                  | an emitter (`EmitterLike`)       | Unit tests, including a test with Node's real `EventEmitter`                                                                             | Stable                                                          |
| `FlatFileErrorAdapter`                      | the file system                  | Real files; the Windows CI job                                                                                                           | Stable                                                          |
| `JsonFileErrorAdapter`                      | the file system                  | Real files; the Windows CI job                                                                                                           | Stable                                                          |
| `SqliteErrorAdapter`                        | a database (`SqliteClientLike`)  | A real in-memory `node:sqlite` database when the Node version has it (10-check test, also run once under `bun:sqlite`), otherwise a fake | Stable. **Decided:** the conditional real-engine test is enough |
| `WebhookErrorAdapter`                       | `fetch`                          | A mocked `fetch` only. `fetch` is the platform's own API                                                                                 | Stable                                                          |
| `CloudWatchLogsErrorAdapter`                | an AWS client                    | Real `@aws-sdk/client-cloudwatch-logs` client type-checked in CI, plus a live test                                                       | Stable                                                          |
| `FirestoreErrorAdapter`                     | a collection                     | Real `@google-cloud/firestore` collection type-checked in CI, plus a live test                                                           | Stable                                                          |
| `S3ErrorAdapter`                            | an S3 client                     | Real `@aws-sdk/client-s3` client type-checked in CI, plus a live test                                                                    | Stable                                                          |
| `SnsErrorAdapter`                           | an SNS client                    | Real `@aws-sdk/client-sns` client type-checked in CI, plus a live test                                                                   | Stable                                                          |
| `MongoDbErrorAdapter`                       | a collection (`CollectionLike`)  | Live test (MongoDB 7 and 8) plus a fake                                                                                                  | Experimental                                                    |
| `MySqlErrorAdapter`, `PostgresErrorAdapter` | a query client (`SqlClientLike`) | Live test (MySQL-family: MariaDB, Percona, MySQL; Postgres-family: Postgres, CockroachDB)                                                | Experimental                                                    |
| `RedisErrorAdapter`                         | a client (`RedisClientLike`)     | Live test (Redis 6 and 7, Valkey 8) plus a fake                                                                                          | Experimental                                                    |
| `SupabaseErrorAdapter`                      | a client (`SupabaseClientLike`)  | A fake only                                                                                                                              | Experimental                                                    |
| `RealtimeDatabaseErrorAdapter`              | a reference                      | A fake only                                                                                                                              | Experimental                                                    |
| `IndexedDbErrorAdapter`                     | a database (`IdbDatabaseLike`)   | A fake only                                                                                                                              | Experimental                                                    |
| `WebStorageErrorAdapter`                    | a storage (`StorageLike`)        | A fake only                                                                                                                              | Experimental                                                    |
| `WebSocketErrorAdapter`                     | a socket (`WebSocketLike`)       | A fake only                                                                                                                              | Experimental                                                    |

**This makes nine of the 21 adapters Experimental.** Most of them can be promoted cheaply, with no server and no credentials: add the real driver as a dev dependency (`mongodb`, `mysql2`, `pg`, `ioredis` or `redis`, `@supabase/supabase-js`, `firebase-admin`, `ws`) and add a test that passes the real client type to the adapter. `tsc --noEmit` then proves the fit in CI, which is rule 2. The two browser adapters could use the browser test setup from `storage-adapters`. **Decision needed:** do that work before 1.0, or ship the nine as Experimental.

## Other value exports

| Export                                                                            | README or docs | Proposed                        | Why                                                                                     |
| --------------------------------------------------------------------------------- | -------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `serializeEntry`, `serializeCause`                                                | Yes            | Stable                          | The record shape every adapter stores                                                   |
| `createErrorLogStore`                                                             | Yes            | Same as `IndexedDbErrorAdapter` | Sets up the IndexedDB store                                                             |
| `buildSqliteErrorLogTableDdl`                                                     | Yes            | Same as `SqliteErrorAdapter`    | SQLite table setup                                                                      |
| `buildErrorLogTableDdl`, `buildMySqlWidenColumnsSql`                              | Yes            | Same as the SQL adapters        | Table setup and migration                                                               |
| `buildSupabaseSetupSql`                                                           | Yes            | Same as `SupabaseErrorAdapter`  | Table setup                                                                             |
| `formatSlackBody`, `formatGoogleChatBody`, `formatDiscordBody`, `formatTeamsBody` | Yes            | Experimental                    | Message shapes follow each service's docs; no live webhook run yet (opt-in test exists) |
| `formatErrorLogLine`                                                              | No. One test   | Internal                        | How the flat file writes a line. No outside caller needs it                             |

**Decided (2026-11-17): renamed.** SQLite's setup function is now `buildSqliteErrorLogTableDdl`, matching `buildErrorLogTableDdl`, with no alias. The table row above, and the other tables, show the old name `buildCreateErrorLogTableSql`: SQLite's setup function was named under a different pattern from the others, which was breaking to fix and fine in 0.x.

## Type exports

- **Contract types** (`ErrorLogAdapter`, `ErrorLogEntry`, `ErrorLogResult`, `SerializedErrorLogEntry`): Stable. `chat-and-react` builds its own error types on them.
- **Option and record types** (`...Options`, `...Record`): Stable alongside the class that takes them.
- **Structural client types** (`CollectionLike`, `SqlClientLike`, `S3ClientLike`, `FileSystemLike` and the other `...Like` types): the contract with each driver. Keep them exported. They carry the label of their adapter. One rule goes into the policy: adding a required member to a `...Like` type is a breaking change.
- **`BatchCapableAdapter`:** Stable. It is the documented way to add `logBatch` to a custom adapter.

## Update: adapter packages and `/kit` (2026-11-17)

Since 0.15 the repository holds a core package and 11 adapter packages under `packages/`, each published and versioned on its own (`<name>-v<version>` tags, see [releasing](releasing.md)). The core stays dependency-free. They are judged by the same rule as the core adapters. This is a proposal until it is approved.

**All 11 meet rule 2.** Each takes a client described by a `...Like` interface, lists the real driver as a dev dependency, and has a test that `tsc --noEmit` and the unit run compile against the real client (`real-driver-types.test.ts`, or `real-arangojs.test.ts`, `real-nano.test.ts` and `real-clients.test.ts` where the test also drives the real client). Each also has an opt-in live test against the real service (`*.live.test.ts`). CI never starts a server for any of them, which is also true of the core adapters.

| Package          | Version | Real client checked in CI                                                         | Live test | Proposed |
| ---------------- | ------- | --------------------------------------------------------------------------------- | --------- | -------- |
| `-arangodb`      | 0.1.0   | `arangojs`                                                                        | Yes       | Stable   |
| `-cassandra`     | 0.1.0   | `cassandra-driver`                                                                | Yes       | Stable   |
| `-clickhouse`    | 0.1.0   | `@clickhouse/client`                                                              | Yes       | Stable   |
| `-couchdb`       | 0.1.0   | `nano`                                                                            | Yes       | Stable   |
| `-google-sheets` | 0.1.0   | `@googleapis/sheets`                                                              | Yes       | Stable   |
| `-influxdb`      | 0.1.0   | `@influxdata/influxdb-client` and `influxdb3-client`, against a local stub server | Yes       | Stable   |
| `-memcached`     | 0.1.0   | `memjs`                                                                           | Yes       | Stable   |
| `-nats`          | 0.1.1   | `nats`                                                                            | Yes       | Stable   |
| `-neo4j`         | 0.1.0   | `neo4j-driver`                                                                    | Yes       | Stable   |
| `-rabbitmq`      | 0.1.0   | `amqplib`                                                                         | Yes       | Stable   |
| `-rethinkdb`     | 0.1.0   | `rethinkdb-ts`                                                                    | Yes       | Stable   |

**A difference from `storage-adapters`.** That package also requires the conformance suite to run against the real server in CI, so it keeps `/gcs`, `/google-drive` and `/google-sheets` Experimental. This package's rule is type fit, which Google Sheets meets. The type fit does not show that the adapter works against the live service; the live tests do, and they are run by hand.

**`/kit`.** It is Experimental "until the first adapter packages have shipped against it". Eleven have. **Proposed: Stable at 1.0.0.** Every package depends on it through the core's peer range, so a breaking change to `/kit` after 1.0 would break all of them. Its exports are the helpers the core adapters use (`reportFailure`, `withTimeout`, `resolveEntryId`, `generateId`, `describeError`, `backoffDelayMs`, `SerialQueue` and their types). If you would rather keep some of them private, decide before 1.0.

**Versions and peer ranges.** Every package declares the core as a peer dependency at `>=0.15.0`. That range has no upper bound and would accept a future 2.0. Proposed: release the core 1.0.0 first, then release each package as 1.0.0 with a peer range of `^1.0.0`. A package whose peer range still says `>=0.15.0` would claim to work with a core it was never tested against.

**What is not covered.** The packages are one to two weeks old and unused outside this repository, as were the first 14 core adapters.

## Findings

1. **The contract is ready to freeze.** One optional field in fourteen releases.
2. **The Stable list holds 12 adapters, and nine are Experimental.** The Experimental list is mostly a gap in tests, not in code, and it can be closed without credentials.
3. **One helper to remove:** `formatErrorLogLine`.
4. **Missing for 1.0:** a versioning and support policy, a `SECURITY.md`, and a `CLAUDE.md`. The ROADMAP still lists "fill in README Getting Started, Usage, and Examples" as to do, but the README has all three sections (about 390 lines), so that line looks stale. I did not compare the README with every adapter.
5. **Dependents.** `chat-and-react` uses only Stable names from here (`ConsoleErrorAdapter` and the contract types). Its dependency range is `^0.2.0`, which on 0.x never reaches a later minor.

## Decisions needed

1. Approve the Stable and Experimental split.
2. ~~Promote the nine Experimental adapters before 1.0 by adding real-driver type tests, or ship them as Experimental?~~ **Decided:** promoted; the type tests were added.
3. ~~Is the conditional `node:sqlite` test enough for `SqliteErrorAdapter` to be Stable?~~ **Decided:** yes, the conditional test is enough.
4. ~~Remove `formatErrorLogLine` in the next minor?~~ **Decided:** removed.
5. ~~Rename one of the two SQL setup functions so they match?~~ **Decided:** renamed to `buildSqliteErrorLogTableDdl`.
6. ~~Graduate `/kit` to Stable at 1.0.0?~~ **Decided:** yes. The `@experimental` tag is removed and `/kit` is covered by the policy from 1.0.0.
7. ~~Take the 11 adapter packages to 1.0.0 together with the core, with a `^1.0.0` core peer range?~~ **Decided:** yes, as a release step: the core first, then each package. The version and peer-range changes are made in the release pull requests, not here.
8. ~~Treat type fit as enough for `-google-sheets`?~~ **Decided:** yes, under this repository's rule.
