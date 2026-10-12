# CLAUDE.md

## Project

`@weareikko/changelog` is a Node.js `>=24`, ESM TypeScript CLI and library, with a GitHub Action (`action.yml`) that runs the published package. `check` validates `.changelog/` fragments and, on a pull or merge request, requires one; `release` folds them into `CHANGELOG.md`. It runs on GitHub Actions and GitLab CI with the same flow.

## Commands

- Install: `npm ci`
- Lint: `npm run lint`
- Format: `npm run format` / `npm run format:check`
- Typecheck (sources and tests): `npm run typecheck`
- Unit tests: `npm test`
- Coverage: `npm run test:ci`
- Build: `npm run build`
- Full local check: `npm run check`
- Run the built CLI: `node bin/changelog.js --help`

## Architecture map

- `src/changelog.ts`: pure fragment parsing and release rendering. No I/O.
- `src/config.ts`: argv (`node:util` `parseArgs`) and environment resolution: platform detection, `CHANGELOG_*` variables, the GitLab token chain (`--gitlab-token`, `GITLAB_TOKEN`, `GLAB_CLI_TOKEN` as `PRIVATE-TOKEN`, then `CI_JOB_TOKEN` as `JOB-TOKEN`), the GitHub event payload.
- `src/platform.ts`: the `Platform` interface and `createPlatform()`. `src/platforms/github.ts` and `src/platforms/gitlab.ts` implement it.
- `src/gitlab.ts`, `src/github.ts`: explicit REST clients with an injectable `fetch`, typed errors and access hints.
- `src/git.ts`: `git` runner (`Git` type, injectable) and the history helpers.
- `src/version.ts`: `--version auto`: the previous version tag (highest semantic version reachable from HEAD), the latest stable version, and the next version (`semver`), with the prerelease rules of `.changelog/prerelease`.
- `src/check.ts`, `src/release.ts`: the two commands. `src/fragments.ts` reads `.changelog/`. `src/output.ts`: annotations, Code Quality report, dotenv, `GITHUB_OUTPUT`, and the `Runtime` type (cwd, env, fetch, git, stdout, stderr).
- `src/cli.ts`: `main(argv, runtime)`, help and version. `bin/changelog.js` imports `dist/cli.js`.
- `src/index.ts`: library exports.

## Coding conventions

- Strict TypeScript, ESM imports with the `.js` suffix for local files.
- oxlint and oxfmt style: 2 spaces, single quotes, semicolons, trailing commas, sorted imports.
- One runtime dependency: `semver`, external in the Vite build. Otherwise use Node.js built-ins.
- The package name and version come from `__PKG_NAME__` and `__PKG_VERSION__` (Vite `define`). Every message names the binary `changelog` or the package `@weareikko/changelog`.
- Errors that reach the user are `ChangelogError` subclasses from `src/errors.ts` with an actionable `hint`. Never put a token in a message, a hint or a log line.
- The GitLab flow must keep working with `CI_JOB_TOKEN` on GitLab 18.4 or later: only call `GET /projects/:id/merge_requests`, `GET /projects/:id/merge_requests/:iid` and `GET /projects/:id/repository/commits/:sha/merge_requests`. Changed files come from local git, not from the API.

## Testing guidance

- Colocated tests: `foo.ts` → `foo.test.ts`. Coverage thresholds are 100% (98% branches).
- Inject `fetch`, `git` and `cwd` (see `src/test-utils.ts`): no network call. File system tests use temporary directories from `makeDirectory()`.
- For an API change, assert the URL, the headers and the error hint.

## Release and repository notes

- Commit messages: English, imperative mood, no conventional commit prefix.
- **Never edit `CHANGELOG.md` directly.** Each pull request adds a fragment `.changelog/<slug>.md` (slug = branch name without its prefix). A fragment only contains `### Added|Changed|Deprecated|Removed|Fixed|Security|Dependencies` headings with their entries. Do not write the pull request number.
- The `Changelog` CI job fails when a pull request changes `src/**`, `bin/**` or `action.yml` without a fragment; set the `no-changelog` label for changes users do not see.
- Each merge into `main` releases with the `Release` workflow (`publish.yml`): `release --version auto` gives the version from the fragments, and no fragment means no release. Run it by hand for another bump: `gh workflow run publish.yml -f bump=major` (or `minor`, `patch`, the `pre*` bumps). Do not tag or publish by hand. Tags have no `v` prefix.
- Prereleases: a pull request adds `.changelog/prerelease` (one line: `alpha`, `beta` or `rc`), each merge then releases the next prerelease, and the pull request that deletes the file releases the stable version. Never delete or edit it outside of such a pull request.
- Mark a breaking entry with `Breaking: `, `**Breaking:** `, `**Breaking**: ` or `⚠️ ` (after the package prefix, if any): from 1.0.0 it gives a major version.
- npm trusted publishing is bound to `publish.yml`: keep the release and publish jobs in that file.
- The CI and the release run the local build (`node bin/changelog.js`), because the action runs the published package at the version of `package.json`.
