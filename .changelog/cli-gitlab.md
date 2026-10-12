### Added

- `@weareikko/changelog` npm package with a `changelog` command, the same as the action, to run `check` and `release` outside GitHub Actions
- GitLab CI support: with a `GITLAB_TOKEN`, `check --require-paths` reads the merge request and its changes, and `release` adds `[[!N]]` merge request references and the entries from `skip-authors`
- `--platform github|gitlab` option, detected from `GITHUB_ACTIONS` and `GITLAB_CI` by default
- `--locale en|fr` option and `locale` input for the French section names of `studiometa/gitlab-ci` (`Ajouté`, `Modifié`, `Déprécié`, `Supprimé`, `Corrigé`, `Sécurité`, `Dépendances`)

### Changed

- An entry with a merge request reference (`[!N]`) also keeps its reference at release, on both platforms
- `release` warns when it cannot look up pull requests (for example without `GITHUB_REPOSITORY`)
