import { check } from './check.js';
import { resolveConfig } from './config.js';
import { formatError } from './errors.js';
import { createGit } from './git.js';
import type { Runtime } from './output.js';
import { createPlatform } from './platform.js';
import { release } from './release.js';

export const HELP = `Usage: changelog check [options]
       changelog release --version <version|auto|calver|patch|minor|major> [options]

${__PKG_NAME__} ${__PKG_VERSION__}: validate .changelog/ fragments on pull and
merge requests, and fold them into CHANGELOG.md at release time.

Commands:
  check                      Validate the fragments. With --require-paths, the open pull or
                             merge request of the run must add a fragment.
  release                    Fold the fragments into a new CHANGELOG.md section and delete them.

Options:
  --require-paths <globs>    check: changes to these files need a fragment (env: CHANGELOG_REQUIRE_PATHS)
  --codequality <file>       check: write a GitLab Code Quality report
  --version <version|auto|calver|patch|minor|major>
                             release: version heading, written as given (1.2.0 or v1.2.0);
                             auto: the next version from the entries; calver: YYYY.M.MICRO
                             from the date and the tags of its month; patch, minor, major:
                             that bump of the current version
  --current <version>        release: with auto or a bump, the version to bump (default: the
                             latest version tag, else 0.0.0; env: CHANGELOG_CURRENT_VERSION)
  --heading-prefix <prefix>  release: text before the version in the heading, e.g. v for
                             "## v1.2.0" (env: CHANGELOG_HEADING_PREFIX)
  --date <YYYY-MM-DD>        release: date of the heading (default: today)
  --notes-file <file>        release: write the new section without its heading
  --dotenv <file>            release: write CHANGELOG_CHANGED and CHANGELOG_VERSION (GitLab dotenv report)
  --skip-label <label>       Label that lifts the fragment requirement (default: no-changelog;
                             env: CHANGELOG_SKIP_LABEL)
  --skip-authors <names>     Authors that need no fragment; release lists their changes under
                             Dependencies (default: renovate[bot] on GitHub, none on GitLab;
                             env: CHANGELOG_SKIP_AUTHORS)
  --locale en|fr             Section names (default: en; env: CHANGELOG_LOCALE)
  --platform github|gitlab   Default: detected from GITHUB_ACTIONS, GITLAB_CI, CI_PROJECT_ID or
                             CI_SERVER_URL, else github (env: CHANGELOG_PLATFORM)
  --project <id|path>        GitLab project (default: CI_PROJECT_ID)
  --mr <iid>                 GitLab merge request (default: CI_MERGE_REQUEST_IID)
  --gitlab-url <url>         GitLab URL (default: CI_SERVER_URL or CI_SERVER_HOST)
  --gitlab-token <token>     GitLab token (default: GITLAB_TOKEN, GLAB_CLI_TOKEN, CI_JOB_TOKEN)
  --github-token <token>     GitHub token (default: GITHUB_TOKEN)
  --help, -h                 Show this help
  --version, -v              Show the version (without a command)

Documentation: https://github.com/weareikko/changelog#readme`;

function defaultRuntime(): Runtime {
  const cwd = process.cwd();
  return {
    cwd,
    env: process.env,
    fetch: globalThis.fetch,
    git: createGit(cwd),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
}

/**
 * Run the `changelog` command and return its exit code: 0 on success, 1 when
 * a check or a release fails, 2 for a usage error.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  overrides: Partial<Runtime> = {},
): Promise<number> {
  const runtime = { ...defaultRuntime(), ...overrides };
  if (overrides.cwd && !overrides.git) runtime.git = createGit(overrides.cwd);

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    runtime.stdout(HELP);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    runtime.stdout(__PKG_VERSION__);
    return 0;
  }

  let config;
  try {
    config = resolveConfig(argv, runtime.env);
  } catch (error) {
    runtime.stderr(formatError(error));
    return 2;
  }

  runtime.stderr(`${__PKG_NAME__} ${__PKG_VERSION__}: ${config.command} on ${config.platform}`);
  try {
    const platform = createPlatform(config, runtime.fetch);
    return config.command === 'check'
      ? await check(config, platform, runtime)
      : await release(config, platform, runtime);
  } catch (error) {
    runtime.stderr(formatError(error));
    return 1;
  }
}
