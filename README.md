# Changelog fragments

A GitHub Action that keeps `CHANGELOG.md` free of merge conflicts. Each pull request adds its own small file in `.changelog/` instead of editing `CHANGELOG.md`. At release time, the action folds all fragments into a new version section, adds the pull request references, and deletes the fragments.

Two pull requests that both add lines under `## Unreleased` edit the same lines of the same file: they conflict, or git merges one of them silently under the wrong heading. Two fragments never touch the same lines.

This is the same fragment format as the `release` job of `studiometa/gitlab-ci`, with English section names.

## Fragments

A fragment is a file `.changelog/<slug>.md`. The slug is free, in kebab-case — usually the branch name without its prefix (`feature/ssh-sync` → `ssh-sync.md`). It only prevents name collisions between pull requests.

A fragment contains one or more `###` sections, each followed by its entries, and nothing else: no `#` or `##` heading, no front matter.

```markdown
### Added

- **CLI**: Add `forge ssh-keys sync` to make server SSH keys match a file

### Fixed

- **Core**: Fix the retry delay of the rate limiter
```

Allowed sections, in the order a release renders them: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Dependencies`.

Do not write the pull request number: the number is not known when you write the fragment. At release time, the action finds the merged pull request that added each fragment and appends `[[#N]]` to each top-level entry, plus the `[#N]: <url>` link definition. An entry that already has a pull request (`[#N]`) or commit (`[abc1234]`) reference, or mentions the pull request, is left as it is: moving old entries into a fragment keeps their original references. Other link definitions (`[abc1234]: https://…`) are allowed anywhere in a fragment; they move to the end of the release section.

Keep a `.changelog/.gitkeep` file so the directory exists when it is empty. The action never reads or deletes it. An empty fragment is ignored and kept for the next release.

## Usage

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

`check` validates every fragment and reports errors as annotations with the file and line. With `require-paths`, a pull request that changes a matching file must also add or edit a fragment, unless it has the `no-changelog` label. The `labeled` and `unlabeled` types re-run the check when the label changes.

### Release

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0 # the action reads the commit that added each fragment

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

`release` validates all fragments first. If one is invalid, it fails and changes nothing. Otherwise it inserts `## <version> - <YYYY-MM-DD>` before the latest release in `CHANGELOG.md` and deletes the fragments it used. It fails if `CHANGELOG.md` already has a section for that version. With no fragment, it changes nothing and sets `changed` to `false`.

The action only edits files. Bumping the version, committing, tagging and publishing stay in your workflow, because they differ from one repository to another.

## Inputs

| Input           | Default               | Description                                                                                         |
| --------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `command`       | —                     | `check` or `release`.                                                                               |
| `version`       | —                     | `release`: version heading, written as given (`1.2.0` or `v1.2.0`).                                 |
| `require-paths` | —                     | `check`: globs, one per line or comma-separated. Matching changes require a fragment.               |
| `skip-label`    | `no-changelog`        | `check`: label that lifts the fragment requirement.                                                 |
| `github-token`  | `${{ github.token }}` | Reads pull request files (`check`) and finds the pull request of each fragment (`release`).         |

## Outputs

| Output    | Description                                                                         |
| --------- | ----------------------------------------------------------------------------------- |
| `changed` | `release`: `true` when `CHANGELOG.md` got a new section.                            |
| `body`    | `release`: the new section without its `##` heading, e.g. for a GitHub Release body. |

The action sets up Node.js 24 with `actions/setup-node`, which stays on the `PATH` for the next steps of the job.

## Local use

The action is a zero-dependency Node.js script. You can run it from a clone:

```sh
node path/to/changelog/cli.mjs check
node path/to/changelog/cli.mjs release --version 1.2.0
```

Outside GitHub Actions, `release` cannot look up pull requests unless `GITHUB_REPOSITORY` (and `GITHUB_TOKEN` for private repositories) are set.

## Development

```sh
npm test
```
