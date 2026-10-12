### Added

- `release --version auto` (and `version: auto` in the action) computes the next version from the entries: a breaking entry (`Breaking: `, `**Breaking:** `, `**Breaking**: ` or `⚠️ `) gives a major version (minor on 0.x), an `Added` entry a minor version (patch on 0.x), other entries a patch, and a prerelease the next prerelease
- `--current` option, `CHANGELOG_CURRENT_VERSION` variable and `current` action input: the version that `--version auto` bumps (default: the previous version tag, else `0.0.0`)
- `version` output (`GITHUB_OUTPUT` and the action): the released version

### Changed

- `CHANGELOG_VERSION` in the `--dotenv` file is empty when `--version auto` has nothing to release
- The previous tag of `--skip-authors` entries is the tag reachable from HEAD with the highest semantic version: a moving major tag (`1`) does not count
- The `semver` package is a dependency
