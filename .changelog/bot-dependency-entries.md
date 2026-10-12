### Added

- `skip-authors` input (default `renovate[bot]`): `check` requires no fragment from these authors, and `release` adds their pull requests merged since the previous tag under `Dependencies`, except the ones with the `skip-label` label
