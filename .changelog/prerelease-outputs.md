### Added

- `release` writes `prerelease` (`true` or `false`) and `dist-tag` (`next` for a prerelease, `latest` for a stable version, empty when nothing is released) to `GITHUB_OUTPUT`, and `CHANGELOG_PRERELEASE` and `CHANGELOG_DIST_TAG` to the `--dotenv` file; the action outputs `prerelease` and `dist-tag` come from it
