# Changelog

All notable changes to this project are documented in this file. Each pull request adds a fragment in `.changelog/`; a release folds them in here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-10-13

### Added

- `release --version patch`, `minor` or `major` forces that bump of the current version, with the rules of `.changelog/prerelease` ([#10])
- The action `release` command also sets the version of `package.json`, commits, tags, pushes, creates the GitHub release with a link to `CHANGELOG.md`, and moves the major and minor tags with `moving-tags: true`; new inputs `commit-message` and `moving-tags`, new outputs `prerelease` and `dist-tag` ([#10])

### Changed

- Breaking: The versions start again at 0.x: 1.0.0 to 1.2.1 are removed; use `weareikko/changelog@0` and `@weareikko/changelog@0` ([#10])
- Breaking: The action `release` command stops when the branch has moved on since the run started, and fetches the history and the tags itself; `version` defaults to `auto` ([#10])

### Removed

- Breaking: The `current` input of the action: the version to bump comes from the tags ([#10])

[#10]: https://github.com/weareikko/changelog/pull/10

## 1.2.1 - 2026-10-12

### Changed

- Pull and merge request references render as (#N) and (!N): `release` writes `([#N])` and `([!N])` instead of `[[#N]]` and `[[!N]]` ([#9])

[#9]: https://github.com/weareikko/changelog/pull/9

## 1.2.0 - 2026-10-12

### Added

- `release --version auto` (and `version: auto` in the action) computes the next version from the entries: a breaking entry (`Breaking: `, `**Breaking:** `, `**Breaking**: ` or `⚠️ `) gives a major version (minor on 0.x), an `Added` entry a minor version (patch on 0.x), other entries a patch, and a prerelease the next prerelease [[#6]]
- `--current` option, `CHANGELOG_CURRENT_VERSION` variable and `current` action input: the version that `--version auto` bumps (default: the previous version tag, else `0.0.0`) [[#6]]
- `version` output (`GITHUB_OUTPUT` and the action): the released version [[#6]]
- `.changelog/prerelease` file: with a prerelease identifier (`alpha`, `beta`, `rc`) in it, `release --version auto` releases prereleases (`1.1.0` → `1.2.0-rc.0` → `1.2.0-rc.1`, a new identifier starts at 0, a bigger change moves to a higher version), and once the file is deleted it releases the stable version, with the line `Stable release of <prerelease>.` when there is no new entry [[#8]]
- `check` validates `.changelog/prerelease`, also in the Code Quality report [[#8]]

### Changed

- `CHANGELOG_VERSION` in the `--dotenv` file is empty when `--version auto` has nothing to release [[#6]]
- The previous tag of `--skip-authors` entries is the tag reachable from HEAD with the highest semantic version: a moving major tag (`1`) does not count [[#6]]
- The `semver` package is a dependency [[#6]]
- Without `.changelog/prerelease`, `release --version auto` on a prerelease releases its stable version instead of the next prerelease [[#8]]

### Fixed

- `release` adds the reference of a stacked pull or merge request merged into another branch, for example with `gh stack merge` [[#5]]

[#5]: https://github.com/weareikko/changelog/pull/5
[#6]: https://github.com/weareikko/changelog/pull/6
[#8]: https://github.com/weareikko/changelog/pull/8

## 1.1.0 - 2026-10-12

### Added

- `skip-authors` input (default `renovate[bot]`): `check` requires no fragment from these authors, and `release` adds their pull requests merged since the previous tag under `Dependencies`, except the ones with the `skip-label` label [[#2]]
- `@weareikko/changelog` npm package with a `changelog` command (`check`, `release`, `--help`, `--version`) for GitHub Actions, GitLab CI and local runs
- GitLab CI support: merge request and branch pipelines for `check`, `[[!N]]` merge request references and `--skip-authors` entries for `release`, with `CI_JOB_TOKEN` on GitLab 18.4 or later or a `GITLAB_TOKEN`
- `--codequality <file>` option of `check`: a GitLab Code Quality report of the fragment errors
- `--dotenv <file>` and `--notes-file <file>` options of `release`, for GitLab dotenv reports and release notes
- `--platform`, `--project`, `--mr`, `--gitlab-url`, `--gitlab-token` and `--github-token` options, and `CHANGELOG_REQUIRE_PATHS`, `CHANGELOG_SKIP_LABEL`, `CHANGELOG_SKIP_AUTHORS`, `CHANGELOG_LOCALE` and `CHANGELOG_PLATFORM` variables
- `--locale en|fr` option and `locale` input for the French section names of `studiometa/gitlab-ci` (`Ajouté`, `Modifié`, `Déprécié`, `Supprimé`, `Corrigé`, `Sécurité`, `Dépendances`)

### Changed

- The action runs `@weareikko/changelog` from npm at the version of its own `package.json`
- `check` reads the pull request, its labels and its author from the event payload and lists the changed files with `git diff`: it makes no API call on GitHub, and the action completes a shallow clone first
- A GitHub workflow that runs `npx @weareikko/changelog check` itself must check out with `fetch-depth: 0`
- `release` only counts a pull request merged into the current branch, and stops on an API error instead of folding the fragments without references
- An entry with a merge request reference (`[!N]`) also keeps its reference at release, on both platforms
- `release` warns when it cannot look up pull requests (for example without `GITHUB_REPOSITORY`)

[#2]: https://github.com/weareikko/changelog/pull/2

## 1.0.3 - 2026-10-12

### Fixed

- Sort pull request link definitions by number, including the ones written in fragments

## 1.0.2 - 2026-10-12

### Fixed

- `release` also leaves entries that already have a commit reference (`[abc1234]`) unchanged

## 1.0.1 - 2026-10-12

### Fixed

- `release` leaves entries that already have a `[#N]` reference unchanged, and adds the pull request link definition only when it adds a reference

## 1.0.0 - 2026-10-12

### Added

- `check` command: validate `.changelog/` fragments and require one on pull requests that change `require-paths`, unless the `no-changelog` label is set
- `release` command: fold fragments into `CHANGELOG.md` in Keep a Changelog order, append pull request references and link definitions, and output the release body
