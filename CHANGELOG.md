# Changelog

All notable changes to this project are documented in this file. Each pull request adds a fragment in `.changelog/`; a release folds them in here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 - 2026-10-12

### Added

- `check` command: validate `.changelog/` fragments and require one on pull requests that change `require-paths`, unless the `no-changelog` label is set
- `release` command: fold fragments into `CHANGELOG.md` in Keep a Changelog order, append pull request references and link definitions, and output the release body
