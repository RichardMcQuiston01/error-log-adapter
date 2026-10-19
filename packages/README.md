# Adapter packages

Optional adapters for less common sinks live here, one workspace package each (for example `packages/rabbitmq`, published as `@richardmcquiston01/error-log-adapter-rabbitmq`). The core package stays dependency-free.

## Conventions

- Depend on the core as a `peerDependency` (`@richardmcquiston01/error-log-adapter`), and in `devDependencies` as `workspace:*`.
- Import the shared helpers from `@richardmcquiston01/error-log-adapter/kit`. Do not copy them.
- Take a client you create, described by a small structural interface, as the core adapters do. If a package needs the driver's types, list the driver as an optional peer dependency.
- Never throw from `log`: return `{ ok: false, error }` through `reportFailure`. Constructors may throw `RangeError` for options that can never work.
- Ship unit tests against a fake client. Live tests are named `*.live.test.ts`.
- Add the same `prepack` script as the other packages (it copies the repository's `LICENSE` into the tarball), and list the package in the root README. Releasing is described in [docs/releasing.md](../docs/releasing.md).
- Build with `tsup` (ESM and CJS), the same as the core.
