# Releasing

The core package (`@richardmcquiston01/error-log-adapter`, at the repository root) and each adapter package under `packages/` are versioned and published separately. A GitHub release triggers the `Publish` workflow, and **the release tag decides what is published**:

| Tag               | Publishes                                                              |
| ----------------- | ---------------------------------------------------------------------- |
| `v0.15.0`         | the core package (`package.json` at the root)                          |
| `rabbitmq-v0.1.0` | `packages/rabbitmq` (`@richardmcquiston01/error-log-adapter-rabbitmq`) |

`scripts/resolve-release.ts` reads the tag, finds the package and refuses the release if anything is off: the version in the tag must equal the package's `package.json`, the package must not be private, and (for an adapter package) the core at that commit must satisfy the package's peer range. The workflow then lints, type-checks, tests and builds everything, checks the tarballs with `scripts/check-pack.ts`, and runs `npm publish --provenance`. A version with a prerelease part (`1.0.0-rc.1`) is published under the `next` npm tag, never `latest`.

## Releasing

Work follows the usual branches: changes go to `dev` through `feature/` pull requests, and `dev` reaches `main` through a pull request.

1. **Prepare the release on a `feature/` branch off `dev`.** Set the new version in each `package.json` that is being released, turn the `Unreleased` heading in `CHANGELOG.md` into the version heading, update `ROADMAP.md` if something has shipped, and merge the pull request into `dev`.
2. **Promote `dev` to `main`** with a pull request, and merge it with a merge commit. Then fast-forward `dev` to `main`.
3. **Check locally if you want to** (nothing here publishes):

   ```bash
   bun install --frozen-lockfile
   bun run lint && bun run typecheck && bun run test
   bun run build && bun run build:packages
   bun scripts/check-pack.ts          # what each tarball would contain
   bun scripts/resolve-release.ts v0.15.0   # what a tag would publish
   ```

4. **Publish the core first.** On GitHub, create a release from `main` with the tag `v<version>`. Wait for the `Publish` workflow to finish: every adapter package lists the core as a peer dependency, so installing one before the core's version exists on npm fails.
5. **Publish each adapter package** the same way, with a release tagged `<package>-v<version>`, for example `rabbitmq-v0.1.0`. The packages are independent of each other and can be released in any order, together or later.

A package's version only has to change when the package changes. If a core release changes something a package depends on (a `/kit` helper, a public type), release the package again with a new version and a peer range that still matches.

## One-time setup

- **`NPM_TOKEN`**: a repository secret holding an npm automation token that may publish under the `@richardmcquiston01` scope. The `Publish` workflow reads it.
- **Provenance**: the workflow has `id-token: write` and publishes with `--provenance`, so each version links back to the commit and workflow that built it. This needs the repository to be public and each package's `repository` field to point at it (`repository.directory` names the package folder; all of them are set).
- **First publish of a scoped package** is public because `publishConfig.access` is `public` in every `package.json`.

## What a tarball holds

Every package ships its `dist/` files (the ones its `exports` map names), `README.md`, `package.json` and `LICENSE`. A package folder has no `LICENSE` of its own: each package's `prepack` script copies the repository's `LICENSE` in just before `npm pack` or `npm publish` (the copy is git-ignored). `scripts/check-pack.ts` runs in CI and in the `Publish` workflow and fails if a tarball lacks one of these or contains `src/` or a test file.

## Adding a new adapter package

Follow `packages/README.md`, and also: add a `prepack` script like the other packages, keep the peer range on the core accurate, and add the package to the table in the root README. The tag for its first release is `<folder name>-v<version>`.
