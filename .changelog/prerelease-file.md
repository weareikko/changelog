### Added

- `.changelog/prerelease` file: with a prerelease identifier (`alpha`, `beta`, `rc`) in it, `release --version auto` releases prereleases (`1.1.0` → `1.2.0-rc.0` → `1.2.0-rc.1`, a new identifier starts at 0, a bigger change moves to a higher version), and once the file is deleted it releases the stable version, with the line `Stable release of <prerelease>.` when there is no new entry
- `check` validates `.changelog/prerelease`, also in the Code Quality report

### Changed

- Without `.changelog/prerelease`, `release --version auto` on a prerelease releases its stable version instead of the next prerelease
