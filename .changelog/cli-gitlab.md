### Added

- `@weareikko/changelog` npm package with a `changelog` command (`check`, `release`, `--help`, `--version`) for GitHub Actions, GitLab CI and local runs
- GitLab CI support: merge request and branch pipelines for `check`, `[[!N]]` merge request references and `--skip-authors` entries for `release`, with `CI_JOB_TOKEN` on GitLab 18.4 or later or a `GITLAB_TOKEN`
- `--codequality <file>` option of `check`: a GitLab Code Quality report of the fragment errors
- `--dotenv <file>` and `--notes-file <file>` options of `release`, for GitLab dotenv reports and release notes
- `--platform`, `--project`, `--mr`, `--gitlab-url`, `--gitlab-token` and `--github-token` options, and `CHANGELOG_REQUIRE_PATHS`, `CHANGELOG_SKIP_LABEL`, `CHANGELOG_SKIP_AUTHORS`, `CHANGELOG_LOCALE` and `CHANGELOG_PLATFORM` variables
- `--locale en|fr` option and `locale` input for the French section names of `studiometa/gitlab-ci` (`Ajouté`, `Modifié`, `Déprécié`, `Supprimé`, `Corrigé`, `Sécurité`, `Dépendances`)

### Changed

- The action runs `@weareikko/changelog` from npm at the version of its own `package.json`
- `check` reads the pull request, its labels and its author from the event payload and lists the changed files with `git diff`: it makes no API call on GitHub, and the action completes a shallow clone first
- `release` only counts a pull request merged into the current branch, and stops on an API error instead of folding the fragments without references
- An entry with a merge request reference (`[!N]`) also keeps its reference at release, on both platforms
- `release` warns when it cannot look up pull requests (for example without `GITHUB_REPOSITORY`)
