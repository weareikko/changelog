### Fixed

- The action `release` command pushes the release commit and its tag in one atomic push, so a refused push leaves neither on the remote
- When the push of the action `release` command fails because the branch has moved on, the run stops with a notice and its outputs show no release (`changed` is `false`, `version` is empty); the run of the newer commit releases. Other push failures fail the step
- The action `release` command accepts a `package.json` that already has the version
