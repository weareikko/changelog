# Changelog fragments

`@weareikko/changelog` keeps `CHANGELOG.md` free of merge conflicts on GitHub and GitLab. Each pull request (or merge request) adds its own small file in `.changelog/` instead of editing `CHANGELOG.md`. At release time, the tool folds all fragments into a new version section, adds the pull or merge request references, and deletes the fragments.

Two pull requests that both add lines under `## Unreleased` edit the same lines of the same file: they conflict, or git merges one of them silently under the wrong heading. Two fragments never touch the same lines.

It is one command line tool, `changelog`, with two commands:

- `changelog check` validates the fragments. On a pull or merge request, it also requires a fragment when the change touches files that you select.
- `changelog release` folds the fragments into `CHANGELOG.md`.

It runs in GitLab CI with `npx`, and in GitHub Actions with `npx` or with the [GitHub Action](#github-actions) of this repository. It needs Node.js 24 or later. Its only dependency is [`semver`](https://www.npmjs.com/package/semver).

```sh
npx @weareikko/changelog check --require-paths 'src/**'
npx @weareikko/changelog release --version 1.2.0
npx @weareikko/changelog release --version auto
```

This is the same fragment format as the `release` job of `studiometa/gitlab-ci`. With `--locale fr`, the sections have the French names of that job.

## Fragments

A fragment is a file `.changelog/<slug>.md`. The slug is free, in kebab-case: usually the branch name without its prefix (`feature/ssh-sync` → `ssh-sync.md`). It only prevents name collisions.

A fragment contains one or more `###` sections, each followed by its entries, and nothing else: no `#` or `##` heading, no front matter.

```markdown
### Added

- **CLI**: Add `forge ssh-keys sync` to make server SSH keys match a file

### Fixed

- **Core**: Fix the retry delay of the rate limiter
```

Allowed sections, in the order a release renders them:

| Locale         | Sections                                                                          |
| -------------- | --------------------------------------------------------------------------------- |
| `en` (default) | `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Dependencies`  |
| `fr`           | `Ajouté`, `Modifié`, `Déprécié`, `Supprimé`, `Corrigé`, `Sécurité`, `Dépendances` |

Do not write the pull request number: it is not known when you write the fragment. At release time, the tool finds the merged pull or merge request that added each fragment and appends a reference to each top-level entry, with its link definition:

- on GitHub, `([#N])` and `[#N]: <repository>/pull/N`, rendered as (#N),
- on GitLab, `([!N])` and `[!N]: <project>/-/merge_requests/N`, rendered as (!N).

An entry that already has a pull request (`[#N]`), merge request (`[!N]`) or commit (`[abc1234]`) reference, or that mentions the reference, stays as it is: old entries moved into a fragment keep their references. Other link definitions (`[abc1234]: https://…`) are allowed anywhere in a fragment; they move to the end of the release section.

Keep a `.changelog/.gitkeep` file so that the directory exists when it is empty. The tool never reads or deletes it. An empty fragment is ignored and kept for the next release.

## `check`

`check` validates every fragment and reports each error with its file and line.

With `--require-paths`, `check` also finds the open pull or merge request of the run. When it changes a file that matches one of the globs, it must add or edit a fragment, unless:

- it has the `--skip-label` label (`no-changelog` by default),
- its author is in `--skip-authors` (bots such as Renovate do not write fragments).

`check` lists the changed files with local git: `git diff --name-status <base>...HEAD`. The clone must have the base commit of the pull or merge request: see [GitHub Actions](#github-actions) and [GitLab CI](#gitlab-ci).

| Platform                      | Pull or merge request                                      | Labels and author                                                             | Base commit                                                                                  |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| GitHub Actions                | `pull_request` event payload                               | event payload                                                                 | `pull_request.base.sha`                                                                      |
| GitLab merge request pipeline | `CI_MERGE_REQUEST_IID`                                     | `CI_MERGE_REQUEST_LABELS`; the author from the API, only for `--skip-authors` | `CI_MERGE_REQUEST_TARGET_BRANCH_SHA` (merged results), else `CI_MERGE_REQUEST_DIFF_BASE_SHA` |
| GitLab branch pipeline        | the open merge request of `CI_COMMIT_BRANCH`, from the API | API                                                                           | API (`diff_refs.base_sha`)                                                                   |

When the run has no open pull or merge request, `check` only validates the fragments.

## `release`

`release --version <version>` validates all fragments first. If one is invalid, it fails and changes nothing. Otherwise it inserts `## <version> - <YYYY-MM-DD>` before the latest release in `CHANGELOG.md` and deletes the fragments that it used. It fails if `CHANGELOG.md` already has a section for that version. The version is written as given (`1.2.0` or `v1.2.0`). `--heading-prefix v` writes `## v1.2.0` and keeps the version (and the tag) `1.2.0`.

For each fragment, `release` finds the commit that added it (`git log --diff-filter=A`) and asks the API which merged pull or merge request contains that commit. When the run knows its branch (`GITHUB_REF`, `CI_COMMIT_BRANCH`), a pull or merge request merged into that branch comes first. Otherwise, any merged pull or merge request counts: a stack merged with `gh stack merge` keeps the base branch of each pull request.

`release` also adds an entry for each pull or merge request of `--skip-authors` merged since the previous tag, on the first-parent history of `HEAD`. The entry goes in the last section (`Dependencies`, or `Dépendances` with `--locale fr`): the title without its conventional commit prefix (`chore(deps): `), with an upper-case first letter, and its reference. These entries come after the `Dependencies` entries of the fragments. `release` skips the ones with the `--skip-label` label and the ones that added a fragment. With no previous tag, it adds none.

The previous tag is the tag reachable from `HEAD` with the highest semantic version (`1.2.0` or `v1.2.0`). Other tags do not count, for example a moving major tag (`1`) or `latest`.

`release` needs the full history and the tags: the action fetches them on GitHub; set `GIT_DEPTH: 0` on GitLab.

### Automatic version

`release --version auto` gets the next version from the entries that it folds (the fragments and the entries of `--skip-authors`). It bumps the current version: `--current <version>` (or `CHANGELOG_CURRENT_VERSION`), else the version of the previous tag, else `0.0.0`. `--version patch`, `minor` or `major` forces that bump instead, for example `--version major` for 1.0.0 after 0.x.

| Entries                                              | From 1.0.0 | On 0.x |
| ---------------------------------------------------- | ---------- | ------ |
| A breaking entry                                     | major      | minor  |
| An entry under `Added` (`Ajouté`), no breaking entry | minor      | patch  |
| Other entries only (fixes, `Dependencies`)           | patch      | patch  |

The `.changelog/prerelease` file turns these versions into prereleases: see [Prereleases](#prereleases). To release a major version without a breaking entry, use `--version major`.

A breaking entry starts with one of these markers, in any case, after an optional package prefix (`**CLI**: ` or `**@scope/pkg:** `):

```markdown
- Breaking: Remove the `--foo` option
- **Breaking:** Remove the `--foo` option
- **BREAKING**: Remove the `sse` MCP transport
- ⚠️ Remove the `--foo` option
- **CLI**: Breaking: Remove the `--foo` option
```

When there is nothing to release, `release --version auto` (or a bump) changes no file, writes `changed=false` and an empty `version`, and exits with 0.

### CalVer

`release --version calver` gives a [CalVer](https://calver.org/) version `YYYY.M.MICRO`, for example `2026.10.2`: the year and the month of `--date` (no leading zero), and `MICRO`, one more than the highest `YYYY.M.MICRO` tag of that month reachable from `HEAD` (`v2026.10.1` counts too), else 0. It is a valid semantic version, so `npm version` accepts it. Like `auto`, it releases only when there are entries: without them, `version` is empty. It ignores `.changelog/prerelease` and does not accept `--current`.

### Prereleases

The file `.changelog/prerelease` holds one line: the prerelease identifier, for example `alpha`, `beta` or `rc` (letters, digits and hyphens, not only digits). It is not a fragment: `release` never deletes it, and `check` validates it. With this file, `release --version auto` releases prereleases. The bump comes from the entries, with the rules above, from the latest stable version tag (`S`):

| Current version | `.changelog/prerelease` | Entries                      | Next version                                                                                                          |
| --------------- | ----------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `1.1.0`         | `rc`                    | an `Added` entry             | `1.2.0-rc.0`                                                                                                          |
| `1.2.0-rc.0`    | `rc`                    | a fix                        | `1.2.0-rc.1`                                                                                                          |
| `1.2.0-beta.3`  | `rc`                    | a fix                        | `1.2.0-rc.0`: a new identifier starts at 0                                                                            |
| `1.2.0-rc.1`    | `rc`                    | a breaking entry (`S` 1.1.0) | `2.0.0-rc.0`: the bump of `S` is above `1.2.0`                                                                        |
| `1.2.0-rc.2`    | none                    | none                         | `1.2.0`: the stable release, with the line `Stable release of 1.2.0-rc.2.` (`Version stable de …` with `--locale fr`) |
| `1.2.0-rc.2`    | none                    | a fix                        | `1.2.0`, with the entries                                                                                             |
| `1.2.0-rc.2`    | none                    | a breaking entry (`S` 1.1.0) | `2.0.0`, with the entries                                                                                             |

With the file and without entries, nothing is released. The new identifier must sort after the current one (`alpha` < `beta` < `rc`), or `release` fails.

The flow with the [release workflow](#release-1) on GitHub:

1. **Enter:** a pull request adds `.changelog/prerelease` (`rc`). The next merge with entries releases `1.2.0-rc.0`.
2. **During:** each merge with entries releases the next prerelease. A pull request that changes the file (`beta` to `rc`) starts the new identifier at 0.
3. **Exit:** a pull request deletes `.changelog/prerelease`. Its merge releases the stable version, with or without new entries.

`--version patch`, `minor` or `major` with the file gives the first prerelease of that bump (`1.1.0` with `minor` and `rc`: `1.2.0-rc.0`), or the stable version without the file.

Without API access (for example on your computer without a token), `release` warns, adds no reference and no entry from `--skip-authors`, and still folds the fragments.

The CLI only edits files. Writing the version in your package files, committing, tagging and publishing stay in your pipeline, or in the [GitHub Action](#release-1).

## Options

| Option                      | Command   | Default                                          | Environment variable        | Description                                                                                                                              |
| --------------------------- | --------- | ------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--require-paths <globs>`   | `check`   | none                                             | `CHANGELOG_REQUIRE_PATHS`   | Globs, one per line or comma-separated. Matching changes require a fragment.                                                             |
| `--codequality <file>`      | `check`   | none                                             |                             | Write a [GitLab Code Quality report](#gitlab-ci) of the errors.                                                                          |
| `--version <version\|auto>` | `release` | required                                         |                             | Version heading, `auto` or `patch`, `minor`, `major` (see [Automatic version](#automatic-version)), or `calver` (see [CalVer](#calver)). |
| `--current <version>`       | `release` | the previous tag, else `0.0.0`                   | `CHANGELOG_CURRENT_VERSION` | With `--version auto` or a bump: the version to bump.                                                                                    |
| `--heading-prefix <prefix>` | `release` | none                                             | `CHANGELOG_HEADING_PREFIX`  | Text before the version in the heading, not in the version: `v` gives `## v1.2.0`.                                                       |
| `--date <YYYY-MM-DD>`       | `release` | today                                            |                             | Date of the version heading, and of the `calver` version.                                                                                |
| `--notes-file <file>`       | `release` | none                                             |                             | Write the new section without its heading (empty when nothing changed).                                                                  |
| `--dotenv <file>`           | `release` | none                                             |                             | Write `CHANGELOG_CHANGED`, `CHANGELOG_VERSION`, `CHANGELOG_PRERELEASE` and `CHANGELOG_DIST_TAG`, the values of the outputs below.        |
| `--skip-label <label>`      | both      | `no-changelog`                                   | `CHANGELOG_SKIP_LABEL`      | Label that lifts the fragment requirement and skips a bot entry.                                                                         |
| `--skip-authors <names>`    | both      | `renovate[bot]` on GitHub, none on GitLab        | `CHANGELOG_SKIP_AUTHORS`    | Logins or usernames, one per line or comma-separated. An empty value means none.                                                         |
| `--locale en\|fr`           | both      | `en`                                             | `CHANGELOG_LOCALE`          | Section names.                                                                                                                           |
| `--platform github\|gitlab` | both      | detected                                         | `CHANGELOG_PLATFORM`        | `github` in GitHub Actions; `gitlab` when `GITLAB_CI`, `CI_PROJECT_ID` or `CI_SERVER_URL` is set; else `github`.                         |
| `--project <id\|path>`      | both      | `CI_PROJECT_ID`                                  |                             | GitLab project.                                                                                                                          |
| `--mr <iid>`                | `check`   | `CI_MERGE_REQUEST_IID`                           |                             | GitLab merge request.                                                                                                                    |
| `--gitlab-url <url>`        | both      | `CI_SERVER_URL`, else `https://$CI_SERVER_HOST`  |                             | GitLab instance.                                                                                                                         |
| `--gitlab-token <token>`    | both      | `GITLAB_TOKEN`, `GLAB_CLI_TOKEN`, `CI_JOB_TOKEN` |                             | GitLab token. See [Tokens](#tokens).                                                                                                     |
| `--github-token <token>`    | both      | `GITHUB_TOKEN`                                   |                             | GitHub token.                                                                                                                            |

Flags win over environment variables. `changelog --help` shows the options and `changelog --version` shows the version. The exit code is 0 on success, 1 when a check or a release fails, and 2 for a usage error.

Outputs:

- `release` appends `changed` (`true` or `false`), `version` (the released version: the given one, or the computed one with `--version auto` or a bump, empty when there is nothing to release), `prerelease` (`true` when the version has a `-` before its build metadata, as in `1.2.0-rc.0`, else `false`), `dist-tag` (the npm dist-tag: `next` for a prerelease, `latest` for a stable version, empty when `version` is empty) and `body` (the new section without its heading) to `GITHUB_OUTPUT` when it is set (GitHub Actions).
- `--dotenv` writes the same values as `CHANGELOG_CHANGED`, `CHANGELOG_VERSION`, `CHANGELOG_PRERELEASE` and `CHANGELOG_DIST_TAG`.
- `--notes-file` and `--dotenv` work on both platforms.
- `check` prints errors as `::error file=…,line=…::` annotations in GitHub Actions, and as `file:line: message` lines elsewhere.

## GitHub Actions

### Check pull requests

```yaml
name: Changelog

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read

jobs:
  changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: weareikko/changelog@0
        with:
          command: check
          require-paths: |
            packages/**
```

The `labeled` and `unlabeled` types run the check again when a label changes. `check` reads the pull request, its labels and its author from the event payload: it makes no API call. Before `check` with `require-paths` on a pull request, the action completes a shallow clone (`git fetch --unshallow`), because `check` lists the changed files with `git diff`. With `fetch-depth: 0`, it fetches nothing.

### Release

Each merge into `main` releases what its fragments describe. In `.github/workflows/publish.yml` of an npm package:

```yaml
name: Release

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      version:
        type: choice
        options: [auto, patch, minor, major]
        default: auto

concurrency:
  group: release
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: write # commit, tag, push and the GitHub release
      pull-requests: read # the pull request of each fragment
    outputs:
      version: ${{ steps.release.outputs.version }}
      dist-tag: ${{ steps.release.outputs.dist-tag }}
    steps:
      - uses: actions/checkout@v5
      - id: release
        uses: weareikko/changelog@0
        with:
          command: release
          version: ${{ inputs.version || 'auto' }}

  publish:
    needs: release
    if: needs.release.outputs.version != ''
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # npm trusted publishing
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/tags/${{ needs.release.outputs.version }}
      - uses: actions/setup-node@v5
        with:
          node-version: '24'
      - run: npm ci && npm run build
      - run: npm publish --provenance --access public --tag "$DIST_TAG"
        env:
          DIST_TAG: ${{ needs.release.outputs.dist-tag }}
```

`release` on GitHub:

1. stops when the branch has moved on since the run started: the run of the newer commit releases,
2. fetches the history and the tags, and folds the fragments with the [automatic version](#automatic-version) (or the given bump or version); without entries, it stops and `version` is empty,
3. sets the version of `package.json` with `npm version`, when it has a `version` field (with `--workspaces --include-workspace-root` when it has `workspaces`),
4. commits `commit-message`, tags the version and pushes them to the branch,
5. with `moving-tags: true`, moves the major (`1`) and minor (`1.2`) tags to a stable version,
6. creates the GitHub release, marked as a prerelease for a prerelease, with a link to `CHANGELOG.md` as its body.

A tag pushed with `GITHUB_TOKEN` starts no workflow, so publish in a job that `needs` the release job. The release commit starts no new run either. A repository without a package (for example a Composer package) only needs the `release` job.

### Inputs

| Input            | Default               | Description                                                                                                                                           |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`        | required              | `check` or `release`.                                                                                                                                 |
| `version`        | `auto`                | `release`: `auto`, `calver`, `patch`, `minor`, `major`, or a version written as given.                                                                |
| `heading-prefix` | none                  | `release`: text before the version in the `CHANGELOG.md` heading, not in the tag (`v` gives `## v1.2.0`).                                             |
| `commit-message` | `Release {version}`   | `release`: message of the release commit. `{version}` is replaced by the version.                                                                     |
| `moving-tags`    | `false`               | `release`: `true` moves the major and minor tags to each stable version, for a repository that is a GitHub Action.                                    |
| `require-paths`  | none                  | `check`: globs, one per line or comma-separated. Matching changes require a fragment.                                                                 |
| `skip-label`     | `no-changelog`        | `check`: label that lifts the fragment requirement. `release`: a pull request from `skip-authors` with this label gets no entry.                      |
| `skip-authors`   | `renovate[bot]`       | Logins, one per line or comma-separated. `check`: their pull requests need no fragment. `release`: their pull requests become `Dependencies` entries. |
| `locale`         | `en`                  | Section names: `en` or `fr`.                                                                                                                          |
| `github-token`   | `${{ github.token }}` | `release`: finds the pull request of each fragment and of each commit since the previous tag, and creates the GitHub release.                         |

### Outputs

| Output       | Description                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `changed`    | `release`: `true` when `CHANGELOG.md` got a new section.                                                      |
| `version`    | `release`: the released version and its tag (empty when there is nothing to release).                         |
| `body`       | `release`: the new section without its `##` heading.                                                          |
| `prerelease` | `release`: `true` for a prerelease version (with a `-`), else `false`.                                        |
| `dist-tag`   | `release`: the npm dist-tag: `next` for a prerelease, else `latest` (empty when there is nothing to release). |

### Version of the action

The action sets up Node.js 24 (it stays on the `PATH` for the next steps) and runs `npx --yes @weareikko/changelog@<version>`, where `<version>` comes from the `package.json` of the action. An action pinned to a commit SHA (for example by Renovate) therefore runs the CLI of that same release, not the latest one. In a checkout of this repository with a build (`dist/cli.js` exists), `uses: ./` runs that build instead: this repository releases and checks itself with its own code. `@0` follows the latest 0.x release, breaking changes included: on 0.x, a breaking change gives a minor version.

## GitLab CI

The tool detects GitLab CI from `GITLAB_CI`, `CI_PROJECT_ID` or `CI_SERVER_URL`. It reads `CI_SERVER_URL`, `CI_PROJECT_ID`, `CI_PROJECT_URL`, `CI_COMMIT_BRANCH` and the `CI_MERGE_REQUEST_*` variables. In a GitLab CI job, `CI_JOB_TOKEN` is enough on GitLab 18.4 or later: see [Tokens](#tokens).

GitLab Code Quality reports show the fragment errors in the merge request widget. A `dotenv` report gives `CHANGELOG_CHANGED`, `CHANGELOG_VERSION`, `CHANGELOG_PRERELEASE` and `CHANGELOG_DIST_TAG` to the next jobs, and `--notes-file` gives the release notes to the [`release` keyword](https://docs.gitlab.com/ci/yaml/#release), which runs `glab` in the job image.

```yaml
stages: [test, release]

changelog:
  stage: test
  image: node:24
  variables:
    # check diffs the merge request from its base commit: the clone must have it.
    GIT_DEPTH: 50
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npx --yes @weareikko/changelog@0 check --require-paths 'src/**' --skip-authors renovate-bot --codequality gl-code-quality-report.json
  artifacts:
    when: always
    reports:
      codequality: gl-code-quality-report.json

changelog:release:
  stage: release
  image: node:24
  variables:
    # release reads the commit that added each fragment, and the tags.
    GIT_DEPTH: 0
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual
  script:
    - npx --yes @weareikko/changelog@0 release --version auto --skip-authors renovate-bot --dotenv release.env --notes-file release-notes.md
    - . ./release.env
    - test "$CHANGELOG_CHANGED" = true || { echo "No fragment and no merge request from skip-authors."; exit 1; }
    # Commit CHANGELOG.md and .changelog/, tag "$CHANGELOG_VERSION" and push
    # them here, with a token that can write to the repository.
  artifacts:
    paths: [release-notes.md]
    reports:
      dotenv: release.env

release:
  stage: release
  image: registry.gitlab.com/gitlab-org/cli:latest
  needs: [changelog:release]
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - echo "Release $CHANGELOG_VERSION"
  release:
    tag_name: $CHANGELOG_VERSION
    description: ./release-notes.md
```

For an npm package, publish the tag `$CHANGELOG_VERSION` in a later job with `npm publish --tag "$CHANGELOG_DIST_TAG"`: `next` for a prerelease, `latest` for a stable version.

Notes:

- **`GIT_DEPTH` for `check`**: the clone must contain the base commit of the merge request. Set `GIT_DEPTH` to more than the number of commits of your merge requests (the GitLab default is 20), or to `0` for the full history. A merged results pipeline only needs a depth of 2. When the commit is missing, `check` fails and says so.
- **`--skip-authors` on GitLab**: GitLab has no fixed bot username, so there is no default. Give the username of your Renovate bot with `--skip-authors` or a `CHANGELOG_SKIP_AUTHORS` CI/CD variable (for example at the group level). Only do this when that user opens dependency updates only: `check` requires no fragment from any of its merge requests, and `release` lists each of them without a fragment under `Dependencies`. When Renovate writes its own fragment (a `postUpgradeTasks` command), leave `--skip-authors` empty.
- **Labels**: in a merge request pipeline, `check` reads the labels from `CI_MERGE_REQUEST_LABELS`. GitLab does not start a pipeline when a label changes: after you set the `no-changelog` label, run the pipeline again.
- **Branch pipelines**: without `CI_MERGE_REQUEST_IID`, `check --require-paths` asks the API for the open merge request of `CI_COMMIT_BRANCH`. When there is none, it only validates the fragments.

## Tokens

| API call (GitLab)                                               | Used by                                                                                                               | `CI_JOB_TOKEN`       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `GET /projects/:id/merge_requests/:iid`                         | `check` in a merge request pipeline, for the author only when `--skip-authors` is set; `check --mr`; branch pipelines | GitLab 18.4 or later |
| `GET /projects/:id/merge_requests?source_branch=…&state=opened` | `check --require-paths` in a branch pipeline                                                                          | GitLab 18.4 or later |
| `GET /projects/:id/repository/commits/:sha/merge_requests`      | `release`: the merge request of each fragment, and of each commit since the previous tag (`--skip-authors`)           | GitLab 18.4 or later |

The changed files (local git) and the labels of a merge request pipeline (`CI_MERGE_REQUEST_LABELS`) need no token.

The token comes from `--gitlab-token`, then `GITLAB_TOKEN`, then `GLAB_CLI_TOKEN` (sent as `PRIVATE-TOKEN`), then `CI_JOB_TOKEN` (sent as `JOB-TOKEN`), like `@weareikko/code-review`.

- **`CI_JOB_TOKEN`**: since GitLab 18.4, the [job token can read](https://docs.gitlab.com/ci/jobs/ci_job_token/#job-token-access) `GET /projects/:id/merge_requests`, `GET /projects/:id/merge_requests/:iid` and `GET /projects/:id/repository/commits/:sha/merge_requests`. It has the role of the user who started the pipeline, who must be able to read merge requests (Reporter or higher). It cannot read `GET /projects/:id/merge_requests/:iid/diffs`: that is why `check` lists the changed files with git. [Fine-grained permissions](https://docs.gitlab.com/ci/jobs/fine_grained_permissions/) (`READ_MERGE_REQUESTS`, `READ_REPOSITORIES`) only limit the job tokens of other projects on the allowlist; the job token of the project itself keeps its access.
- **`GITLAB_TOKEN`**: on GitLab older than 18.4, or to read another project, set it to a project access token with the `read_api` scope and the `Reporter` role, as a masked CI/CD variable. Do not make it protected when `check` runs on merge requests from unprotected branches: a protected variable does not reach them.

When GitLab refuses a request (401, 403 or 404), the error names the token source and what it needs.

On GitHub, `check` needs no token. `release` uses `GITHUB_TOKEN` (`github-token` in the action) with `contents: read` and `pull-requests: read`.

## Library

The package also exports the functions that parse fragments and build a release section, and the report formats: `parseFragment`, `buildRelease`, `insertSection`, `addReference`, `titleToEntry`, `isFragmentPath`, `SECTIONS`, `LOCALES`, `formatCodeQuality` and `formatDotenv`.

```js
import { parseFragment, SECTIONS } from '@weareikko/changelog';

const { errors } = parseFragment(text, '.changelog/a.md', SECTIONS.en);
```

## Development

```sh
npm ci
npm run check          # lint, format, typecheck, tests
npm run test:ci        # tests with coverage
npm run build          # dist/ for bin/changelog.js
node bin/changelog.js --help
```

The tests inject `fetch`, `git` and the working directory: they make no network call. See `CLAUDE.md` for the architecture.

### Release

Each merge into `main` starts the `Release` workflow (`publish.yml`), which uses the action of the same commit: see [Release](#release-1) under GitHub Actions. Without a fragment and without a pull request from `renovate[bot]`, it releases nothing. Run it by hand to force a bump, for example a major version without a breaking entry:

```sh
gh workflow run publish.yml -f version=major
```

For prereleases, use the [prerelease file](#prereleases).

The release job builds the package, then runs the action of the same commit, which runs that build: the release uses the code that the test job has just tested. The publish job builds and publishes `@weareikko/changelog` with trusted publishing (OIDC, no token) and provenance.

When the publish job fails, "Re-run failed jobs" publishes what is left. Do not edit `CHANGELOG.md`, `package.json` versions or tags by hand.
