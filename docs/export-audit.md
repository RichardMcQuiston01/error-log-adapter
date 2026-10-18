# Export audit (1.0 readiness)

Every export of `@richardmcquiston01/error-log-adapter`, with a proposed label for 1.0. The package has one entry point (`.`), so the labels apply to names, not to subpaths.

- **Stable:** covered by semver from 1.0. A breaking change needs a new major version.
- **Experimental:** exported and documented as experimental. It may change in a minor release, and the changelog says so. It moves to Stable once it meets the rule below.
- **Internal:** no longer exported, or exported but documented as unsupported.

**Rule for Stable.** An adapter is Stable when either of these holds:

1. It takes no outside client, and its unit tests exercise real behavior (the file system, Node's `EventEmitter`).
2. It takes a client, and the real client from the vendor's SDK is passed to it in a test that `tsc --noEmit` compiles in CI. That proves the hand-written `...Like` interface fits the real client, and it keeps fitting when the SDK changes.

An adapter whose only evidence is a fake client it was written against is Experimental. A fake can only agree with the interface it was written from.

This is a proposal. Nothing is removed or relabeled until it is approved.

## What the evidence shows

- **All of 0.1.0 to 0.13.0 shipped between 2026-10-14 and 2026-10-18.** Thirteen tags in five days. No adapter has had time in other people's hands, so the rule above rests on tests, not on soak time.
- **The contract has barely changed.** Since 0.1.0 the only change to `ErrorLogEntry`, `ErrorLogResult` and `ErrorLogAdapter` is the optional `id` field. That makes the 1.0 contract safe to freeze.
- **CI never touches a real service.** The CI workflow runs lint, type checks, unit tests and the build, on Linux and on Windows. The four opt-in live tests (CloudWatch Logs, Firestore, S3, SNS) are run by hand with credentials. They also matter for rule 2: they pass the real SDK client straight into the adapter, so the type check in CI compiles that fit.
- **Most adapters have only fakes.** See the tiers below.

## Adapters

| Adapter                                     | Takes                            | Evidence                                                                               | Proposed                                                         |
| ------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `ConsoleErrorAdapter`                       | nothing                          | Unit tests. `chat-and-react` extends it                                                | Stable                                                           |
| `CompositeErrorAdapter`                     | other adapters                   | Unit tests with fake adapters. It has no client of its own                             | Stable                                                           |
| `BatchingErrorAdapter`                      | another adapter                  | Unit tests                                                                             | Stable                                                           |
| `EventEmitterErrorAdapter`                  | an emitter (`EmitterLike`)       | Unit tests, including a test with Node's real `EventEmitter`                           | Stable                                                           |
| `FlatFileErrorAdapter`                      | the file system                  | Real files; the Windows CI job                                                         | Stable                                                           |
| `JsonFileErrorAdapter`                      | the file system                  | Real files; the Windows CI job                                                         | Stable                                                           |
| `SqliteErrorAdapter`                        | a database (`SqliteClientLike`)  | A real in-memory `node:sqlite` database when the Node version has it, otherwise a fake | Stable. **Decision needed:** the real-engine test is conditional |
| `WebhookErrorAdapter`                       | `fetch`                          | A mocked `fetch` only. `fetch` is the platform's own API                               | Stable                                                           |
| `CloudWatchLogsErrorAdapter`                | an AWS client                    | Real `@aws-sdk/client-cloudwatch-logs` client type-checked in CI, plus a live test     | Stable                                                           |
| `FirestoreErrorAdapter`                     | a collection                     | Real `@google-cloud/firestore` collection type-checked in CI, plus a live test         | Stable                                                           |
| `S3ErrorAdapter`                            | an S3 client                     | Real `@aws-sdk/client-s3` client type-checked in CI, plus a live test                  | Stable                                                           |
| `SnsErrorAdapter`                           | an SNS client                    | Real `@aws-sdk/client-sns` client type-checked in CI, plus a live test                 | Stable                                                           |
| `MongoDbErrorAdapter`                       | a collection (`CollectionLike`)  | A fake only. `mongodb` is not a dev dependency                                         | Experimental                                                     |
| `MySqlErrorAdapter`, `PostgresErrorAdapter` | a query client (`SqlClientLike`) | A fake only. `mysql2` and `pg` are not dev dependencies                                | Experimental                                                     |
| `RedisErrorAdapter`                         | a client (`RedisClientLike`)     | A fake only                                                                            | Experimental                                                     |
| `SupabaseErrorAdapter`                      | a client (`SupabaseClientLike`)  | A fake only                                                                            | Experimental                                                     |
| `RealtimeDatabaseErrorAdapter`              | a reference                      | A fake only                                                                            | Experimental                                                     |
| `IndexedDbErrorAdapter`                     | a database (`IdbDatabaseLike`)   | A fake only                                                                            | Experimental                                                     |
| `WebStorageErrorAdapter`                    | a storage (`StorageLike`)        | A fake only                                                                            | Experimental                                                     |
| `WebSocketErrorAdapter`                     | a socket (`WebSocketLike`)       | A fake only                                                                            | Experimental                                                     |

**This makes nine of the 21 adapters Experimental.** Most of them can be promoted cheaply, with no server and no credentials: add the real driver as a dev dependency (`mongodb`, `mysql2`, `pg`, `ioredis` or `redis`, `@supabase/supabase-js`, `firebase-admin`, `ws`) and add a test that passes the real client type to the adapter. `tsc --noEmit` then proves the fit in CI, which is rule 2. The two browser adapters could use the browser test setup from `storage-adapters`. **Decision needed:** do that work before 1.0, or ship the nine as Experimental.

## Other value exports

| Export                                               | README or docs | Proposed                        | Why                                                         |
| ---------------------------------------------------- | -------------- | ------------------------------- | ----------------------------------------------------------- |
| `serializeEntry`, `serializeCause`                   | Yes            | Stable                          | The record shape every adapter stores                       |
| `createErrorLogStore`                                | Yes            | Same as `IndexedDbErrorAdapter` | Sets up the IndexedDB store                                 |
| `buildCreateErrorLogTableSql`                        | Yes            | Same as `SqliteErrorAdapter`    | SQLite table setup                                          |
| `buildErrorLogTableDdl`, `buildMySqlWidenColumnsSql` | Yes            | Same as the SQL adapters        | Table setup and migration                                   |
| `buildSupabaseSetupSql`                              | Yes            | Same as `SupabaseErrorAdapter`  | Table setup                                                 |
| `formatErrorLogLine`                                 | No. One test   | Internal                        | How the flat file writes a line. No outside caller needs it |

**A naming inconsistency to settle before 1.0.** SQLite's setup function is `buildCreateErrorLogTableSql` and the others' is `buildErrorLogTableDdl`. They do the same job under two naming patterns. Renaming one is breaking, which is fine in 0.x. **Decision needed.**

## Type exports

- **Contract types** (`ErrorLogAdapter`, `ErrorLogEntry`, `ErrorLogResult`, `SerializedErrorLogEntry`): Stable. `chat-and-react` builds its own error types on them.
- **Option and record types** (`...Options`, `...Record`): Stable alongside the class that takes them.
- **Structural client types** (`CollectionLike`, `SqlClientLike`, `S3ClientLike`, `FileSystemLike` and the other `...Like` types): the contract with each driver. Keep them exported. They carry the label of their adapter. One rule goes into the policy: adding a required member to a `...Like` type is a breaking change.
- **`BatchCapableAdapter`:** Stable. It is the documented way to add `logBatch` to a custom adapter.

## Findings

1. **The contract is ready to freeze.** One optional field in thirteen releases.
2. **The Stable list holds 12 adapters, and nine are Experimental.** The Experimental list is mostly a gap in tests, not in code, and it can be closed without credentials.
3. **One helper to remove:** `formatErrorLogLine`.
4. **Missing for 1.0:** a versioning and support policy, a `SECURITY.md`, and a `CLAUDE.md`. The ROADMAP still lists "fill in README Getting Started, Usage, and Examples" as to do, but the README has all three sections (about 390 lines), so that line looks stale. I did not compare the README with every adapter.
5. **Dependents.** `chat-and-react` uses only Stable names from here (`ConsoleErrorAdapter` and the contract types). Its dependency range is `^0.2.0`, which on 0.x never reaches a later minor.

## Decisions needed

1. Approve the Stable and Experimental split.
2. Promote the nine Experimental adapters before 1.0 by adding real-driver type tests, or ship them as Experimental?
3. Is the conditional `node:sqlite` test enough for `SqliteErrorAdapter` to be Stable?
4. Remove `formatErrorLogLine` in the next minor?
5. Rename one of the two SQL setup functions so they match?
