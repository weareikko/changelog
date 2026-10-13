import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LOCALES, SECTIONS, type Locale } from './changelog.js';
import { ConfigError } from './errors.js';
import { isComputedVersion } from './version.js';

export const COMMANDS = ['check', 'release'] as const;
export type Command = (typeof COMMANDS)[number];

export const PLATFORMS = ['github', 'gitlab'] as const;
export type PlatformName = (typeof PLATFORMS)[number];

export type GitLabAuthHeader = 'PRIVATE-TOKEN' | 'JOB-TOKEN';

/** Where the GitLab token came from, for error hints. Never the token itself. */
export type GitLabTokenSource =
  | '--gitlab-token'
  | 'GITLAB_TOKEN'
  | 'GLAB_CLI_TOKEN'
  | 'CI_JOB_TOKEN';

export const DEFAULT_SKIP_LABEL = 'no-changelog';

/**
 * Authors whose pull requests need no fragment and become `Dependencies`
 * entries at release. GitLab has no fixed bot name: set yours with
 * `--skip-authors` or `CHANGELOG_SKIP_AUTHORS`.
 */
export const DEFAULT_SKIP_AUTHORS: Record<PlatformName, string[]> = {
  github: ['renovate[bot]'],
  gitlab: [],
};

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_GITHUB_SERVER_URL = 'https://github.com';

/** The pull request of a GitHub Actions run, from its event payload. */
export interface GitHubEventPull {
  number: number;
  author: string | undefined;
  labels: string[];
  baseSha: string;
}

export interface GitHubConfig {
  apiUrl: string;
  serverUrl: string;
  /** `owner/repo`, from `GITHUB_REPOSITORY`. */
  repository: string;
  token: string;
  /** The branch of a push or `workflow_dispatch` run, from `GITHUB_REF`. */
  branch: string;
  pull: GitHubEventPull | null;
}

export interface GitLabConfig {
  /** Instance URL without `/api/v4`. */
  url: string;
  /** Project ID or path. */
  project: string;
  /** Project web URL, for `[!N]: <url>/-/merge_requests/N` definitions. */
  projectUrl: string;
  /** Merge request IID (`--mr` or `CI_MERGE_REQUEST_IID`). */
  mr: string;
  /**
   * Labels of a merge request pipeline (`CI_MERGE_REQUEST_LABELS`), or null
   * when the run did not get them from GitLab CI (then the API gives them).
   */
  mrLabels: string[] | null;
  /** The commit the merge request diff starts from, in a merge request pipeline. */
  mrBaseSha: string;
  /** `CI_COMMIT_BRANCH`: set in branch pipelines, not in merge request pipelines. */
  branch: string;
  token: string;
  authHeader: GitLabAuthHeader;
  tokenSource: GitLabTokenSource | null;
}

export interface Config {
  command: Command;
  platform: PlatformName;
  locale: Locale;
  sections: readonly string[];
  requirePaths: string[];
  skipLabel: string;
  skipAuthors: string[];
  /**
   * The version heading, `auto` to compute it from the entries, or `patch`,
   * `minor`, `major` to bump the current version.
   */
  version: string;
  /** For `--version auto` or a bump: the version to bump. Empty: the latest tag. */
  current: string;
  date: string;
  dotenv: string;
  notesFile: string;
  codequality: string;
  github: GitHubConfig;
  gitlab: GitLabConfig;
}

type Env = Record<string, string | undefined>;

const OPTIONS = {
  'require-paths': { type: 'string' },
  'skip-label': { type: 'string' },
  'skip-authors': { type: 'string' },
  locale: { type: 'string' },
  platform: { type: 'string' },
  version: { type: 'string' },
  current: { type: 'string' },
  date: { type: 'string' },
  dotenv: { type: 'string' },
  'notes-file': { type: 'string' },
  codequality: { type: 'string' },
  project: { type: 'string' },
  mr: { type: 'string' },
  'gitlab-url': { type: 'string' },
  'gitlab-token': { type: 'string' },
  'github-token': { type: 'string' },
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = Partial<Record<OptionName, string>>;

/** Options that only one command reads. The others apply to both. */
const COMMAND_ONLY: Partial<Record<OptionName, Command>> = {
  'require-paths': 'check',
  codequality: 'check',
  version: 'release',
  current: 'release',
  date: 'release',
  dotenv: 'release',
  'notes-file': 'release',
};

/** Split a list given one per line or comma-separated. */
export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

function parseCommandLine(argv: string[]): { command: Command; values: Values } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new ConfigError((error as Error).message, { hint: 'Run "changelog --help".' });
  }
  const [command, ...extra] = parsed.positionals;
  if (!COMMANDS.includes(command as Command)) {
    throw new ConfigError(`Unknown command "${command}".`, {
      hint: `Use ${COMMANDS.join(' or ')}. Run "changelog --help".`,
    });
  }
  if (extra.length > 0) {
    throw new ConfigError(`Unexpected argument "${extra[0]}".`, {
      hint: 'Run "changelog --help".',
    });
  }
  const values = parsed.values as Values;
  for (const name of Object.keys(values) as OptionName[]) {
    const only = COMMAND_ONLY[name];
    if (only && only !== command) {
      throw new ConfigError(`--${name} only applies to "changelog ${only}".`);
    }
  }
  return { command: command as Command, values };
}

/**
 * `--platform` (or `CHANGELOG_PLATFORM`) wins. Otherwise GitHub Actions is
 * `github`, GitLab CI is `gitlab`, and a run outside CI is `github`.
 */
export function detectPlatform(explicit: string | undefined, env: Env): PlatformName {
  const name = (explicit ?? '').trim().toLowerCase();
  if (name) {
    if ((PLATFORMS as readonly string[]).includes(name)) return name as PlatformName;
    throw new ConfigError(`Unknown platform "${name}".`, {
      hint: `--platform (or CHANGELOG_PLATFORM) must be one of: ${PLATFORMS.join(', ')}.`,
    });
  }
  if (env.GITHUB_ACTIONS === 'true') return 'github';
  if (env.GITLAB_CI === 'true' || env.CI_PROJECT_ID || env.CI_SERVER_URL) return 'gitlab';
  return 'github';
}

function resolveLocale(value: string | undefined): Locale {
  const locale = (value || 'en').trim().toLowerCase();
  if (!(LOCALES as string[]).includes(locale)) {
    throw new ConfigError(`Unknown locale "${locale}".`, {
      hint: `--locale (or CHANGELOG_LOCALE) must be one of: ${LOCALES.join(', ')}.`,
    });
  }
  return locale as Locale;
}

/**
 * The same chain as `@weareikko/code-review`: `--gitlab-token`, then
 * `GITLAB_TOKEN`, `GLAB_CLI_TOKEN` (both sent as `PRIVATE-TOKEN`), then the
 * job token `CI_JOB_TOKEN` (sent as `JOB-TOKEN`).
 */
export function resolveGitLabToken(
  flag: string | undefined,
  env: Env,
): { token: string; authHeader: GitLabAuthHeader; tokenSource: GitLabTokenSource | null } {
  if (flag) return { token: flag, authHeader: 'PRIVATE-TOKEN', tokenSource: '--gitlab-token' };
  if (env.GITLAB_TOKEN) {
    return { token: env.GITLAB_TOKEN, authHeader: 'PRIVATE-TOKEN', tokenSource: 'GITLAB_TOKEN' };
  }
  if (env.GLAB_CLI_TOKEN) {
    return {
      token: env.GLAB_CLI_TOKEN,
      authHeader: 'PRIVATE-TOKEN',
      tokenSource: 'GLAB_CLI_TOKEN',
    };
  }
  if (env.CI_JOB_TOKEN) {
    return { token: env.CI_JOB_TOKEN, authHeader: 'JOB-TOKEN', tokenSource: 'CI_JOB_TOKEN' };
  }
  return { token: '', authHeader: 'PRIVATE-TOKEN', tokenSource: null };
}

/** The pull request of a `pull_request` or `pull_request_target` event payload. */
export function parseGitHubEvent(json: string | undefined): GitHubEventPull | null {
  if (!json) return null;
  let event: {
    pull_request?: {
      number?: number;
      user?: { login?: string };
      labels?: { name?: string }[];
      base?: { sha?: string };
    } | null;
  };
  try {
    event = JSON.parse(json);
  } catch {
    throw new ConfigError('The GitHub event payload (GITHUB_EVENT_PATH) is not valid JSON.');
  }
  const pull = event.pull_request;
  if (!pull || typeof pull.number !== 'number') return null;
  return {
    number: pull.number,
    author: pull.user?.login,
    labels: (pull.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
    baseSha: pull.base?.sha ?? '',
  };
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function resolveGitHub(values: Values, env: Env, readFile: (path: string) => string | undefined) {
  const ref = env.GITHUB_REF ?? '';
  return {
    apiUrl: (env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL).replace(/\/$/, ''),
    serverUrl: (env.GITHUB_SERVER_URL || DEFAULT_GITHUB_SERVER_URL).replace(/\/$/, ''),
    repository: env.GITHUB_REPOSITORY ?? '',
    token: first(values['github-token'], env.GITHUB_TOKEN) ?? '',
    branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '',
    pull: env.GITHUB_EVENT_PATH ? parseGitHubEvent(readFile(env.GITHUB_EVENT_PATH)) : null,
  } satisfies GitHubConfig;
}

function resolveGitLab(values: Values, env: Env): GitLabConfig {
  const url = (
    first(
      values['gitlab-url'],
      env.CI_SERVER_URL,
      env.CI_SERVER_HOST ? `https://${env.CI_SERVER_HOST}` : undefined,
    ) ?? ''
  ).replace(/\/$/, '');
  const project = first(values.project, env.CI_PROJECT_ID) ?? '';
  // A project path gives the web URL; a numeric ID needs CI_PROJECT_URL.
  const projectUrl = (
    first(
      values.project ? undefined : env.CI_PROJECT_URL,
      url && project.includes('/') ? `${url}/${project}` : undefined,
    ) ?? ''
  ).replace(/\/$/, '');
  const fromPipeline = !values.mr && Boolean(env.CI_MERGE_REQUEST_IID);
  return {
    url,
    project,
    projectUrl,
    mr: first(values.mr, env.CI_MERGE_REQUEST_IID) ?? '',
    mrLabels: fromPipeline ? splitList(env.CI_MERGE_REQUEST_LABELS) : null,
    // In a merged results pipeline, HEAD merges the source branch into the
    // target branch head: diff from that head, not from the older merge base.
    mrBaseSha: fromPipeline
      ? (first(env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA, env.CI_MERGE_REQUEST_DIFF_BASE_SHA) ?? '')
      : '',
    branch: env.CI_COMMIT_BRANCH ?? '',
    ...resolveGitLabToken(values['gitlab-token'], env),
  };
}

/**
 * Resolve the command, its options and the platform settings from the
 * command line and the environment. Flags win over `CHANGELOG_*` variables,
 * which win over the defaults.
 */
export function resolveConfig(
  argv: string[],
  env: Env,
  readFile: (path: string) => string | undefined = readOptionalFile,
): Config {
  const { command, values } = parseCommandLine(argv);
  const platform = detectPlatform(values.platform ?? env.CHANGELOG_PLATFORM, env);
  const locale = resolveLocale(values.locale ?? env.CHANGELOG_LOCALE);
  const skipAuthors = values['skip-authors'] ?? env.CHANGELOG_SKIP_AUTHORS;

  const config: Config = {
    command,
    platform,
    locale,
    sections: SECTIONS[locale],
    requirePaths: splitList(values['require-paths'] ?? env.CHANGELOG_REQUIRE_PATHS),
    skipLabel: first(values['skip-label'], env.CHANGELOG_SKIP_LABEL) ?? DEFAULT_SKIP_LABEL,
    skipAuthors:
      skipAuthors === undefined ? DEFAULT_SKIP_AUTHORS[platform] : splitList(skipAuthors),
    version: values.version ?? '',
    current: first(values.current, env.CHANGELOG_CURRENT_VERSION) ?? '',
    date: values.date || new Date().toISOString().slice(0, 10),
    dotenv: values.dotenv ?? '',
    notesFile: values['notes-file'] ?? '',
    codequality: values.codequality ?? '',
    github: resolveGitHub(values, env, readFile),
    gitlab: resolveGitLab(values, env),
  };

  if (command === 'release' && !config.version) {
    throw new ConfigError('Missing --version.', {
      hint: 'Pass the version heading, e.g. "changelog release --version 1.2.0", "--version auto" or "--version minor".',
    });
  }
  if (values.current && !isComputedVersion(config.version)) {
    throw new ConfigError('--current only applies to "--version auto", patch, minor or major.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.date)) {
    throw new ConfigError(`Invalid --date "${config.date}".`, { hint: 'Use YYYY-MM-DD.' });
  }
  return config;
}
