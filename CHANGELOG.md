# Changelog

All notable changes to this project are documented in this file. Each pull request adds a fragment in `.changelog/`; a release folds them in here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
