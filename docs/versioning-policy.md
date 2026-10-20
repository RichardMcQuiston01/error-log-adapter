# Versioning, support and deprecation

> **Draft defaults.** The numbers on this page (support windows, deprecation period, supported environments) are proposed defaults for review. They take effect at 1.0.0. Until then the package is 0.x and a minor release may break things, as the changelog shows.

This page says what you can rely on from 1.0.0 onward. Every export is labeled Stable or Experimental in the [export audit](export-audit.md).

## What is public

A change to any of these that could break working code is a breaking change.

- **The contract.** `ErrorLogAdapter`, `ErrorLogEntry`, `ErrorLogResult` and `SerializedErrorLogEntry`, and what they promise: `log` returns a `Promise<ErrorLogResult>` and does not throw, a failing sink is reported through the result, and `id` is optional on an entry.
- **Every adapter export**, with its documented options, return values and behavior: `ConsoleErrorAdapter`, `CompositeErrorAdapter`, `BatchingErrorAdapter`, `EventEmitterErrorAdapter`, `FlatFileErrorAdapter`, `JsonFileErrorAdapter`, `SqliteErrorAdapter`, `MySqlErrorAdapter`, `PostgresErrorAdapter`, `WebhookErrorAdapter`, `MongoDbErrorAdapter`, `RedisErrorAdapter`, `S3ErrorAdapter`, `CloudWatchLogsErrorAdapter`, `SnsErrorAdapter`, `FirestoreErrorAdapter`, `RealtimeDatabaseErrorAdapter`, `SupabaseErrorAdapter`, `IndexedDbErrorAdapter`, `WebStorageErrorAdapter` and `WebSocketErrorAdapter`.
- **The helpers**: `serializeEntry`, `serializeCause`, `createErrorLogStore`, `buildCreateErrorLogTableSql`, `buildErrorLogTableDdl`, `buildMySqlWidenColumnsSql` and `buildSupabaseSetupSql`.
- **The structural client types**, such as `SqlClientLike`, `S3ClientLike` and `FileSystemLike`. They are the contract between an adapter and a client. Adding a required member to one is a breaking change, because code written against the old shape stops compiling. The real client's own type must keep fitting without a cast.
- **`BatchCapableAdapter`**, the documented way to add `logBatch` to a custom adapter.
- **Documented stored layouts.** Where the README describes what an adapter writes (the `error_log` table and its columns, the line format of `FlatFileErrorAdapter`, the NDJSON records, S3 object keys, Firestore document ids), a later release of the same major version still reads what an earlier one wrote. Changing a documented layout without a migration is breaking.

Not public, and free to change in any release: anything not exported, the text of error messages (the `code` is public, the wording is not), and the files in `dist/`.

## Experimental

An export tagged `@experimental` in the type definitions is **not covered** by the rules on this page. It may change in a minor release, and the changelog says so under the release that changes it. At 1.0.0 nothing is tagged.

An adapter is Stable when either of these holds, and a new adapter starts as Experimental until it does:

1. It takes no outside client, and its tests exercise real behavior (the file system, Node's `EventEmitter`).
2. It takes a client, and the real client type from the vendor's SDK is assigned to the adapter's `...Like` interface in a test that `tsc --noEmit` compiles in CI.

Rule 2 proves the type fits and keeps fitting when the SDK changes. It does not prove the adapter works against a live service; the opt-in live tests cover that for CloudWatch Logs, Firestore, S3, SNS, Redis, MongoDB, MySQL and Postgres.

## Version numbers

The package follows [Semantic Versioning](https://semver.org/).

| Change                                                                                                                                                                                                                   | Example                                | Bumps     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | --------- |
| Removing or renaming a Stable export; changing behavior in a way that can break callers; adding a required member to a client type; changing a documented stored layout without migration; requiring a newer environment | renaming `buildCreateErrorLogTableSql` | **major** |
| Adding an adapter, an option, or an optional member to a client type; adding a field to the stored record                                                                                                                | a new adapter                          | **minor** |
| A bug fix, a documentation change, or an internal change                                                                                                                                                                 | fixing a retry that waited too long    | **patch** |

A bug fix can change behavior that someone relied on. If the old behavior contradicted the documentation, it is a bug fix. If the documentation described it, it is a breaking change.

## Support

The maintainer supports each release line on a best-effort basis:

| Line                                  | Gets                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| The latest minor of the current major | Bug fixes and security fixes                                                             |
| The last minor of the previous major  | Security fixes and critical bug fixes, for **6 months** after the next major is released |
| Anything older                        | Nothing. Upgrade                                                                         |

Fixes are released as patch versions. There is no guaranteed response time. To report a security problem, see [SECURITY.md](../SECURITY.md).

## Deprecation

Within a major version, something is deprecated before it is removed.

1. **Announce.** The release that deprecates it marks it `@deprecated` in the type definitions, with what to use instead, and lists it in the changelog.
2. **Keep.** It keeps working, unchanged, for at least **3 months and one minor release**.
3. **Remove.** It is removed in the next major version, not before.

The exception is a security fix. If something cannot be kept safe, it can change in a minor or patch release, and the changelog says why.

## Environments

- **Node.js** 20 or later. Dropping a Node.js version after it leaves long-term support is not treated as breaking, and the changelog announces it.
- **Browsers:** `IndexedDbErrorAdapter` and `WebStorageErrorAdapter` need the platform's IndexedDB, Web Storage and (optionally) Web Locks APIs. A browser version that lacks them is not supported.
- **Clients** (`pg`, `mysql2`, `redis`, `mongodb`, the AWS SDK, the Firebase SDKs, `supabase-js`, `ws`) are not dependencies of this package. The adapters accept them through structural types. A client major version that breaks one of those types is fixed in this package and, if the fix changes a public type, released as a major version.

## Prereleases

Before a major version, release candidates (`1.0.0-rc.1`) let you try the change. A release candidate is not covered by this page and can change before the release. It is published under the `next` npm tag, never `latest`.
