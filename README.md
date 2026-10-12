# Changelog fragments

A GitHub Action and a command line tool (`@weareikko/changelog` on npm) that keep `CHANGELOG.md` free of merge conflicts, on GitHub Actions and GitLab CI. Each pull request (or merge request) adds its own small file in `.changelog/` instead of editing `CHANGELOG.md`. At release time, the tool folds all fragments into a new version section, adds the pull request references, and deletes the fragments.

Two pull requests that both add lines under `## Unreleased` edit the same lines of the same file: they conflict, or git merges one of them silently under the wrong heading. Two fragments never touch the same lines.

This is the same fragment format as the `release` job of `studiometa/gitlab-ci`. With `--locale fr`, the sections have the French names of that job.

## Fragments

A fragment is a file `.changelog/<slug>.md`. The slug is free, in kebab-case — usually the branch name without its prefix (`feature/ssh-sync` → `ssh-sync.md`). It only prevents name collisions between pull requests.

A fragment contains one or more `###` sections, each followed by its entries, and nothing else: no `#` or `##` heading, no front matter.

```markdown
### Added

- **CLI**: Add `forge ssh-keys sync` to make server SSH keys match a file

### Fixed

- **Core**: Fix the retry delay of the rate limiter
```

Allowed sections, in the order a release renders them:

| Locale         | Sections                                                                                |
| -------------- | --------------------------------------------------------------------------------------- |
| `en` (default) | `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Dependencies`        |
| `fr`           | `Ajouté`, `Modifié`, `Déprécié`, `Supprimé`, `Corrigé`, `Sécurité`, `Dépendances`       |

Do not write the pull request number: the number is not known when you write the fragment. At release time, the tool finds the merged pull request that added each fragment and appends a reference to each top-level entry, plus its link definition:

- on GitHub, `[[#N]]` and `[#N]: <repository>/pull/N`,
- on GitLab, `[[!N]]` and `[!N]: <project>/-/merge_requests/N`.

An entry that already has a pull request (`[#N]`), merge request (`[!N]`) or commit (`[abc1234]`) reference, or mentions the pull request, is left as it is: moving old entries into a fragment keeps their original references. Other link definitions (`[abc1234]: https://…`) are allowed anywhere in a fragment; they move to the end of the release section.

Keep a `.changelog/.gitkeep` file so the directory exists when it is empty. The tool never reads or deletes it. An empty fragment is ignored and kept for the next release.

## GitHub Actions

### Check pull requests

```yaml
name: Changelog

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: read

jobs:
  changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: weareikko/changelog@1
        with:
          command: check
          require-paths: |
            packages/**
```

`check` validates every fragment and reports errors as annotations with the file and line. With `require-paths`, a pull request that changes a matching file must also add or edit a fragment, unless it has the `no-changelog` label or its author is in `skip-authors` (`renovate[bot]` by default). The `labeled` and `unlabeled` types re-run the check when the label changes.

### Release

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0 # the action reads the commit that added each fragment, and the tags

- id: changelog
  uses: weareikko/changelog@1
  with:
    command: release
    version: ${{ steps.version.outputs.version }}

- env:
    VERSION: ${{ steps.version.outputs.version }}
  run: |
    git add CHANGELOG.md .changelog
    git commit -m "Release $VERSION"
```

Pass expressions to `run:` through `env:`, never inline, to avoid shell injection.

`release` validates all fragments first. If one is invalid, it fails and changes nothing. Otherwise it inserts `## <version> - <YYYY-MM-DD>` before the latest release in `CHANGELOG.md` and deletes the fragments it used. It fails if `CHANGELOG.md` already has a section for that version. With no fragment and no pull request from `skip-authors`, it changes nothing and sets `changed` to `false`.

## Pull requests from bots

A bot such as Renovate does not write fragments. `check` does not require a fragment from the authors in `skip-authors` (`renovate[bot]` by default). The fragments that they add are still validated.

At release time, `release` also lists the pull requests of these authors that were merged since the previous tag (`git describe --tags --abbrev=0`), on the first-parent history of `HEAD`. Each one becomes an entry of the last section (`### Dependencies`, or `### Dépendances` with `--locale fr`): the pull request title without its conventional commit prefix (`chore(deps): `), with an upper-case first letter, its reference and the link definition. These entries come after the `Dependencies` entries of the fragments. `release` skips:

- the pull requests with the `skip-label` label (`no-changelog`), e.g. development dependency updates,
- the pull requests that already added a fragment.

With no previous tag, `release` adds no such entry. Pull requests from `skip-authors` alone are enough for a new section, with `changed` set to `true`.

The tool only edits files. Bumping the version, committing, tagging and publishing stay in your workflow, because they differ from one repository to another.

## Action inputs

| Input           | Default               | Description                                                                                                                                            |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command`       | —                     | `check` or `release`.                                                                                                                                  |
| `version`       | —                     | `release`: version heading, written as given (`1.2.0` or `v1.2.0`).                                                                                    |
| `require-paths` | —                     | `check`: globs, one per line or comma-separated. Matching changes require a fragment.                                                                  |
| `skip-label`    | `no-changelog`        | `check`: label that lifts the fragment requirement. `release`: a pull request from `skip-authors` with this label gets no entry.                       |
| `skip-authors`  | `renovate[bot]`       | Logins, one per line or comma-separated. `check`: their pull requests need no fragment. `release`: their pull requests become `Dependencies` entries.  |
| `locale`        | `en`                  | Section names: `en` or `fr`.                                                                                                                           |
| `github-token`  | `${{ github.token }}` | Reads pull request files (`check`), and finds the pull request of each fragment and of each commit since the previous tag (`release`).                 |

## Action outputs

| Output    | Description                                                                         |
| --------- | ----------------------------------------------------------------------------------- |
| `changed` | `release`: `true` when `CHANGELOG.md` got a new section.                            |
| `body`    | `release`: the new section without its `##` heading, e.g. for a GitHub Release body. |

The action sets up Node.js 24 with `actions/setup-node`, which stays on the `PATH` for the next steps of the job.

## Command line

The npm package `@weareikko/changelog` has the same `changelog` command as the action (the action runs its own copy and installs nothing). It has no dependency and needs Node.js 24 or later.

```sh
npx @weareikko/changelog@1 check --require-paths 'src/**'
npx @weareikko/changelog@1 release --version 1.2.0
```

| Option                     | Command | Default                              | Description                                                                                       |
| -------------------------- | ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `--require-paths <globs>`  | `check` | —                                    | On a pull or merge request: matching changes require a fragment.                                  |
| `--version <version>`      | release | —                                    | Version heading, written as given (`1.2.0` or `v1.2.0`).                                          |
| `--date <YYYY-MM-DD>`      | release | today                                | Date of the version heading.                                                                      |
| `--skip-label <label>`     | both    | `no-changelog`                       | Same as the `skip-label` input.                                                                   |
| `--skip-authors <logins>`  | both    | `renovate[bot]`                      | Same as the `skip-authors` input. On GitLab, use the username of your bot (e.g. `renovate-bot`).  |
| `--locale en\|fr`          | both    | `en`                                 | Section names.                                                                                    |
| `--platform github\|gitlab` | both    | `gitlab` in GitLab CI, else `github` | API to read pull or merge requests from. `GITLAB_CI=true` selects `gitlab`, except in GitHub Actions. |

The command reads these environment variables. GitHub Actions and GitLab CI set them, except the tokens.

| Platform | Variables                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| GitHub   | `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, `GITHUB_EVENT_PATH` (`check`), `GITHUB_API_URL`, `GITHUB_SERVER_URL`, `GITHUB_OUTPUT` |
| GitLab   | `CI_API_V4_URL`, `CI_PROJECT_ID`, `CI_PROJECT_URL`, `CI_MERGE_REQUEST_IID` (`check`), `GITLAB_TOKEN`          |

Without them (for example on your computer), `release` warns, adds no reference and no entry from `skip-authors`, and still folds the fragments. Set them to look up pull requests from your computer; `CI_PROJECT_ID` can also be the project path (`group/project`).

The package also exports the functions that parse fragments and build a release section (`parseFragment`, `buildRelease`, `insertSection`, `SECTIONS`, …) from `@weareikko/changelog`.

## GitLab CI

### Token

The GitLab API needs a token in the `GITLAB_TOKEN` CI/CD variable: `check` reads the merge request and its changed files, and `release` finds the merge request of each fragment and of each commit since the previous tag. `CI_JOB_TOKEN` cannot read these endpoints.

Create a project access token with the `Reporter` role and the `read_api` scope, and add it as a masked CI/CD variable `GITLAB_TOKEN`. Do not make it protected if the `check` job runs on merge requests from unprotected branches: a protected variable is not available there.

Without a token:

- `release` warns and folds the fragments without `[[!N]]` references and without entries from `skip-authors`,
- `check` still validates the fragments, but `check --require-paths` fails on a merge request with a clear error.

### Check merge requests

```yaml
changelog:
  stage: test
  image: node:24
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npx --yes @weareikko/changelog@1 check --locale fr --require-paths 'src/**' --skip-authors renovate-bot
```

GitLab does not start a pipeline when a label changes: after you set the `no-changelog` label, retry the job. The job reads the labels from the API when it runs.

### Release

```yaml
release:
  stage: release
  image: node:24
  variables:
    # The tool reads the commit that added each fragment, and the tags.
    GIT_DEPTH: 0
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - VERSION=... # compute the version
    - npx --yes @weareikko/changelog@1 release --version "v$VERSION" --locale fr --skip-authors renovate-bot
    - git add CHANGELOG.md .changelog
    - git commit -m "Release $VERSION"
    # tag and push
```

`release` writes the merge request references as `[[!N]]` with `[!N]: <project>/-/merge_requests/N`. On GitLab, it sets no output: `git status --porcelain` tells if `CHANGELOG.md` changed.

## Development

```sh
npm test
```

The tests use `node --test` and inject the file system root, the environment, `fetch` and `git`: they make no network call.

### Release

Run the `Release` workflow (`publish.yml`) from `main`:

```sh
gh workflow run publish.yml -f bump=minor
gh workflow run publish.yml -f bump=preminor -f preid=rc   # 1.1.0-rc.0
gh workflow run publish.yml -f bump=prerelease -f preid=rc # 1.1.0-rc.1
gh workflow run publish.yml -f bump=minor                  # 1.1.0 after 1.1.0-rc.1
```

The workflow:

1. runs the tests, bumps `package.json` (`npm version`), and folds `.changelog/` into `CHANGELOG.md` with the action of this repository,
2. commits `Release <version>`, tags `<version>` (no `v` prefix), moves the major tag (`1`) for a stable version only, and pushes to `main`,
3. publishes `@weareikko/changelog` to npm with trusted publishing (OIDC, no token) and provenance: a prerelease (a version with a `-`) goes to the `next` dist-tag, any other version to `latest`; a version that npm already has is skipped,
4. creates the GitHub release, marked as a prerelease and not as the latest release for a prerelease.

When the publish job fails, "Re-run failed jobs" publishes what is left. Do not edit `CHANGELOG.md`, `package.json` versions or tags by hand.
