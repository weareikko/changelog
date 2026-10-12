import { describe, expect, it } from 'vitest';
import { SECTIONS } from './changelog.js';
import {
  detectPlatform,
  parseGitHubEvent,
  resolveConfig,
  resolveGitLabToken,
  splitList,
} from './config.js';
import { ConfigError } from './errors.js';

const GITLAB_MR_ENV = {
  GITLAB_CI: 'true',
  CI_SERVER_URL: 'https://gitlab.example.com/',
  CI_PROJECT_ID: '42',
  CI_PROJECT_URL: 'https://gitlab.example.com/group/project/',
  CI_MERGE_REQUEST_IID: '7',
  CI_MERGE_REQUEST_LABELS: 'bug,no-changelog',
  CI_MERGE_REQUEST_DIFF_BASE_SHA: 'base123',
  CI_JOB_TOKEN: 'job-token',
};

function configError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('Expected a ConfigError');
}

describe('splitList', () => {
  it('splits on commas and new lines and drops blanks', () => {
    expect(splitList(' a, b\n\nc ,')).toEqual(['a', 'b', 'c']);
    expect(splitList(undefined)).toEqual([]);
  });
});

describe('detectPlatform', () => {
  it('lets the explicit value win', () => {
    expect(detectPlatform(' GitLab ', { GITHUB_ACTIONS: 'true' })).toBe('gitlab');
  });

  it('rejects an unknown platform with a hint', () => {
    const error = configError(() => detectPlatform('bitbucket', {}));
    expect(error.message).toBe('Unknown platform "bitbucket".');
    expect(error.hint).toContain('github, gitlab');
  });

  it('detects GitHub Actions first, then GitLab CI, else GitHub', () => {
    expect(detectPlatform(undefined, { GITHUB_ACTIONS: 'true', GITLAB_CI: 'true' })).toBe('github');
    expect(detectPlatform(undefined, { GITLAB_CI: 'true' })).toBe('gitlab');
    expect(detectPlatform(undefined, { CI_PROJECT_ID: '1' })).toBe('gitlab');
    expect(detectPlatform(undefined, { CI_SERVER_URL: 'https://gitlab.com' })).toBe('gitlab');
    expect(detectPlatform('', {})).toBe('github');
  });
});

describe('resolveGitLabToken', () => {
  it('follows the code-review chain with the right header', () => {
    const env = { GITLAB_TOKEN: 'a', GLAB_CLI_TOKEN: 'b', CI_JOB_TOKEN: 'c' };
    expect(resolveGitLabToken('flag', env)).toEqual({
      token: 'flag',
      authHeader: 'PRIVATE-TOKEN',
      tokenSource: '--gitlab-token',
    });
    expect(resolveGitLabToken(undefined, env).tokenSource).toBe('GITLAB_TOKEN');
    expect(resolveGitLabToken(undefined, { GLAB_CLI_TOKEN: 'b', CI_JOB_TOKEN: 'c' })).toEqual({
      token: 'b',
      authHeader: 'PRIVATE-TOKEN',
      tokenSource: 'GLAB_CLI_TOKEN',
    });
    expect(resolveGitLabToken(undefined, { CI_JOB_TOKEN: 'c' })).toEqual({
      token: 'c',
      authHeader: 'JOB-TOKEN',
      tokenSource: 'CI_JOB_TOKEN',
    });
    expect(resolveGitLabToken(undefined, {})).toEqual({
      token: '',
      authHeader: 'PRIVATE-TOKEN',
      tokenSource: null,
    });
  });
});

describe('parseGitHubEvent', () => {
  it('reads the pull request of the payload', () => {
    const json = JSON.stringify({
      pull_request: {
        number: 12,
        user: { login: 'renovate[bot]' },
        labels: [{ name: 'deps' }, {}],
        base: { sha: 'abc' },
      },
    });
    expect(parseGitHubEvent(json)).toEqual({
      number: 12,
      author: 'renovate[bot]',
      labels: ['deps'],
      baseSha: 'abc',
    });
    expect(parseGitHubEvent(JSON.stringify({ pull_request: { number: 3 } }))).toEqual({
      number: 3,
      author: undefined,
      labels: [],
      baseSha: '',
    });
  });

  it('returns null without a pull request', () => {
    expect(parseGitHubEvent(undefined)).toBeNull();
    expect(parseGitHubEvent('{"ref":"refs/heads/main"}')).toBeNull();
    expect(parseGitHubEvent('{"pull_request":null}')).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseGitHubEvent('{')).toThrow(/not valid JSON/);
  });
});

describe('resolveConfig', () => {
  it('rejects unknown options, commands and arguments with exit-ready errors', () => {
    expect(configError(() => resolveConfig(['check', '--nope'], {})).hint).toBe(
      'Run "changelog --help".',
    );
    expect(configError(() => resolveConfig(['publish'], {})).message).toBe(
      'Unknown command "publish".',
    );
    expect(configError(() => resolveConfig(['check', 'extra'], {})).message).toBe(
      'Unexpected argument "extra".',
    );
  });

  it('rejects options of the other command', () => {
    expect(configError(() => resolveConfig(['check', '--version', '1.0.0'], {})).message).toBe(
      '--version only applies to "changelog release".',
    );
    expect(
      configError(() => resolveConfig(['release', '--version', '1', '--codequality', 'x'], {}))
        .message,
    ).toBe('--codequality only applies to "changelog check".');
  });

  it('requires a version and a valid date for release', () => {
    expect(configError(() => resolveConfig(['release'], {})).message).toBe('Missing --version.');
    expect(
      configError(() => resolveConfig(['release', '--version', '1', '--date', '12/10/2026'], {}))
        .message,
    ).toBe('Invalid --date "12/10/2026".');
  });

  it('rejects an unknown locale', () => {
    expect(configError(() => resolveConfig(['check', '--locale', 'de'], {})).hint).toContain(
      'en, fr',
    );
  });

  it('uses the defaults outside CI', () => {
    const config = resolveConfig(['release', '--version', '1.2.0'], {});
    expect(config).toMatchObject({
      command: 'release',
      platform: 'github',
      locale: 'en',
      sections: SECTIONS.en,
      requirePaths: [],
      skipLabel: 'no-changelog',
      skipAuthors: ['renovate[bot]'],
      version: '1.2.0',
      dotenv: '',
      notesFile: '',
      codequality: '',
      github: {
        apiUrl: 'https://api.github.com',
        serverUrl: 'https://github.com',
        repository: '',
        token: '',
        branch: '',
        pull: null,
      },
    });
    expect(config.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reads CHANGELOG_* variables, and flags win over them', () => {
    const env = {
      CHANGELOG_REQUIRE_PATHS: 'src/**\nbin/**',
      CHANGELOG_SKIP_LABEL: 'skip',
      CHANGELOG_SKIP_AUTHORS: 'foxy, bot',
      CHANGELOG_LOCALE: 'fr',
      CHANGELOG_PLATFORM: 'gitlab',
    };
    expect(resolveConfig(['check'], env)).toMatchObject({
      platform: 'gitlab',
      locale: 'fr',
      sections: SECTIONS.fr,
      requirePaths: ['src/**', 'bin/**'],
      skipLabel: 'skip',
      skipAuthors: ['foxy', 'bot'],
    });
    expect(
      resolveConfig(
        [
          'check',
          '--skip-authors',
          '',
          '--skip-label',
          'other',
          '--locale',
          'en',
          '--platform',
          'github',
        ],
        env,
      ),
    ).toMatchObject({ platform: 'github', locale: 'en', skipLabel: 'other', skipAuthors: [] });
  });

  it('has no default skip-authors on GitLab', () => {
    expect(resolveConfig(['check'], { GITLAB_CI: 'true' }).skipAuthors).toEqual([]);
  });

  it('reads the GitHub Actions environment and event payload', () => {
    const config = resolveConfig(
      ['check', '--github-token', 'flag-token'],
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'acme/repo',
        GITHUB_TOKEN: 'env-token',
        GITHUB_API_URL: 'https://ghe.example.com/api/v3/',
        GITHUB_SERVER_URL: 'https://ghe.example.com/',
        GITHUB_REF: 'refs/pull/3/merge',
        GITHUB_EVENT_PATH: '/event.json',
      },
      (path) => (path === '/event.json' ? '{"pull_request":{"number":3}}' : undefined),
    );
    expect(config.github).toEqual({
      apiUrl: 'https://ghe.example.com/api/v3',
      serverUrl: 'https://ghe.example.com',
      repository: 'acme/repo',
      token: 'flag-token',
      branch: '',
      pull: { number: 3, author: undefined, labels: [], baseSha: '' },
    });
    expect(
      resolveConfig(['check'], { GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: '/missing' })
        .github,
    ).toMatchObject({ branch: 'main', pull: null });
  });

  it('reads a GitLab merge request pipeline', () => {
    expect(resolveConfig(['check'], GITLAB_MR_ENV).gitlab).toEqual({
      url: 'https://gitlab.example.com',
      project: '42',
      projectUrl: 'https://gitlab.example.com/group/project',
      mr: '7',
      mrLabels: ['bug', 'no-changelog'],
      mrBaseSha: 'base123',
      branch: '',
      token: 'job-token',
      authHeader: 'JOB-TOKEN',
      tokenSource: 'CI_JOB_TOKEN',
    });
  });

  it('diffs a merged results pipeline from the target branch head', () => {
    const config = resolveConfig(['check'], {
      ...GITLAB_MR_ENV,
      CI_MERGE_REQUEST_TARGET_BRANCH_SHA: 'target456',
    });
    expect(config.gitlab.mrBaseSha).toBe('target456');
  });

  it('has no diff base when the pipeline gives none', () => {
    const { CI_MERGE_REQUEST_DIFF_BASE_SHA: _, ...env } = GITLAB_MR_ENV;
    expect(resolveConfig(['check'], env).gitlab.mrBaseSha).toBe('');
  });

  it('reads a GitLab branch pipeline and CI_SERVER_HOST', () => {
    expect(
      resolveConfig(['release', '--version', '1'], {
        GITLAB_CI: 'true',
        CI_SERVER_HOST: 'gitlab.example.com',
        CI_PROJECT_ID: '42',
        CI_COMMIT_BRANCH: 'main',
        GITLAB_TOKEN: 'secret',
      }).gitlab,
    ).toMatchObject({
      url: 'https://gitlab.example.com',
      projectUrl: '',
      mr: '',
      mrLabels: null,
      mrBaseSha: '',
      branch: 'main',
      authHeader: 'PRIVATE-TOKEN',
      tokenSource: 'GITLAB_TOKEN',
    });
  });

  it('lets GitLab flags win and builds the project URL from a path', () => {
    const config = resolveConfig(
      [
        'check',
        '--platform',
        'gitlab',
        '--gitlab-url',
        'https://gitlab.com/',
        '--project',
        'acme/repo',
        '--mr',
        '9',
        '--gitlab-token',
        'flag',
      ],
      GITLAB_MR_ENV,
    );
    expect(config.gitlab).toMatchObject({
      url: 'https://gitlab.com',
      project: 'acme/repo',
      projectUrl: 'https://gitlab.com/acme/repo',
      mr: '9',
      mrLabels: null,
      mrBaseSha: '',
      tokenSource: '--gitlab-token',
    });
  });

  it('has no project URL for a numeric --project without CI_PROJECT_URL', () => {
    const config = resolveConfig(
      ['check', '--project', '42', '--gitlab-url', 'https://g.test'],
      {},
    );
    expect(config.gitlab.projectUrl).toBe('');
  });
});
