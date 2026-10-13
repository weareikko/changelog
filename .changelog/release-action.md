### Added

- `release --version patch`, `minor` or `major` forces that bump of the current version, with the rules of `.changelog/prerelease`
- The action `release` command also sets the version of `package.json`, commits, tags, pushes, creates the GitHub release with a link to `CHANGELOG.md`, and moves the major and minor tags with `moving-tags: true`; new inputs `commit-message` and `moving-tags`, new outputs `prerelease` and `dist-tag`

### Changed

- Breaking: The versions start again at 0.x: 1.0.0 to 1.2.1 are removed; use `weareikko/changelog@0` and `@weareikko/changelog@0`
- Breaking: The action `release` command stops when the branch has moved on since the run started, and fetches the history and the tags itself; `version` defaults to `auto`

### Removed

- Breaking: The `current` input of the action: the version to bump comes from the tags
