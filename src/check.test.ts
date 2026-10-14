import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from './check.js';
import { resolveConfig } from './config.js';
import type { Git } from './git.js';
import { createPlatform } from './platform.js';
import { makeDirectory, makeRuntime, routeFetch, tableGit } from './test-utils.js';

const VALID = { '.changelog/a.md': '### Added\n\n- A\n', '.changelog/.gitkeep': '' };

const DIFF = '-c core.quotepath=false diff --name-status --no-renames -z base...HEAD';

/** `git diff --name-status -z` output. */
function nameStatus(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, status]) => `${status}\0${path}\0`)
    .join('');
}

function run(
  argv: string[],
  options: {
    files?: Record<string, string>;
    env?: Record<string, string>;
    event?: object;
    git?: Git;
    fetch?: typeof fetch;
  } = {},
) {
  const cwd = makeDirectory(options.files ?? VALID);
  const env = { ...options.env, ...(options.event ? { GITHUB_EVENT_PATH: '/event.json' } : {}) };
  const config = resolveConfig(['check', ...argv], env, () => JSON.stringify(options.event));
  const runtime = makeRuntime(cwd, {
    env,
    ...(options.git ? { git: options.git } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    cwd,
    runtime,
    code: check(config, createPlatform(config, runtime.fetch, runtime.git), runtime),
  };
}

const PULL = {
  pull_request: { number: 5, user: { login: 'dev' }, labels: [], base: { sha: 'base' } },
};

describe('check', () => {
  it('validates the fragments', async () => {
    const { runtime, code } = run([]);
    expect(await code).toBe(0);
    expect(runtime.out).toEqual(['1 fragment(s) valid.']);
  });

  it('reports invalid fragments and writes them to the Code Quality report', async () => {
    const { cwd, runtime, code } = run(['--codequality', 'gl-code-quality-report.json'], {
      files: { '.changelog/a.md': '## Oops\n### Added\n- A\n' },
    });
    expect(await code).toBe(1);
    expect(runtime.out).toEqual([]);
    expect(runtime.err).toEqual([
      '.changelog/a.md:1: Heading "## Oops" is not allowed. A fragment only contains "### <Section>" headings.',
    ]);
    const report = JSON.parse(readFileSync(join(cwd, 'gl-code-quality-report.json'), 'utf8'));
    expect(report).toMatchObject([
      {
        check_name: 'changelog-fragment',
        location: { path: '.changelog/a.md', lines: { begin: 1 } },
      },
    ]);
  });

  it('accepts a valid prerelease file', async () => {
    const { runtime, code } = run([], { files: { ...VALID, '.changelog/prerelease': 'rc\n' } });
    expect(await code).toBe(0);
    expect(runtime.out).toEqual([
      '1 fragment(s) valid.',
      'Prerelease "rc": releases are prereleases.',
    ]);
  });

  it('reports an invalid prerelease file in the Code Quality report', async () => {
    const { cwd, runtime, code } = run(['--codequality', 'cq.json'], {
      files: { ...VALID, '.changelog/prerelease': 'rc\nbeta\n' },
    });
    expect(await code).toBe(1);
    expect(runtime.err).toEqual([
      '.changelog/prerelease:2: The prerelease file has more than one line. Write only the prerelease identifier.',
    ]);
    expect(JSON.parse(readFileSync(join(cwd, 'cq.json'), 'utf8'))).toMatchObject([
      {
        check_name: 'changelog-prerelease',
        location: { path: '.changelog/prerelease', lines: { begin: 2 } },
      },
    ]);
  });

  it('writes an empty Code Quality report when all is valid', async () => {
    const { cwd, code } = run(['--codequality', 'cq.json']);
    expect(await code).toBe(0);
    expect(readFileSync(join(cwd, 'cq.json'), 'utf8')).toBe('[]\n');
  });

  it('requires nothing outside a pull request', async () => {
    const { runtime, code } = run(['--require-paths', 'src/**']);
    expect(await code).toBe(0);
    expect(runtime.out).toContain('No open pull request for this run: no fragment required.');
  });

  describe('on a GitHub pull request', () => {
    it('fails when matching files change without a fragment', async () => {
      const { runtime, code } = run(['--require-paths', 'src/**, action.yml'], {
        env: { GITHUB_ACTIONS: 'true' },
        event: PULL,
        git: tableGit({
          [DIFF]: nameStatus({ 'src/a.ts': 'M', 'README.md': 'M', '.changelog/old.md': 'D' }),
        }),
      });
      expect(await code).toBe(1);
      expect(runtime.err).toEqual([
        '::error file=.changelog,line=1::This pull request changes 1 file(s) matching src/**, action.yml (e.g. src/a.ts) but adds no fragment in .changelog/. Add one, or set the "no-changelog" label.',
      ]);
    });

    it('passes with a new or edited fragment', async () => {
      const { code } = run(['--require-paths', 'src/**'], {
        event: PULL,
        git: tableGit({ [DIFF]: nameStatus({ 'src/a.ts': 'M', '.changelog/a.md': 'A' }) }),
      });
      expect(await code).toBe(0);
    });

    it('passes when no matching file changes', async () => {
      const { code } = run(['--require-paths', 'src/**'], {
        event: PULL,
        git: tableGit({ [DIFF]: nameStatus({ 'docs/a.md': 'M' }) }),
      });
      expect(await code).toBe(0);
    });

    it('requires nothing with the skip label', async () => {
      const { runtime, code } = run(['--require-paths', 'src/**', '--skip-label', 'internal'], {
        event: { pull_request: { ...PULL.pull_request, labels: [{ name: 'internal' }] } },
      });
      expect(await code).toBe(0);
      expect(runtime.out).toContain('Label "internal" is set: no fragment required.');
    });

    it('requires nothing from skip-authors, and checks other authors', async () => {
      const bot = run(['--require-paths', 'src/**'], {
        event: { pull_request: { ...PULL.pull_request, user: { login: 'renovate[bot]' } } },
      });
      expect(await bot.code).toBe(0);
      expect(bot.runtime.out).toContain(
        'Author "renovate[bot]" is in skip-authors: no fragment required.',
      );

      const anonymous = run(['--require-paths', 'src/**'], {
        event: { pull_request: { ...PULL.pull_request, user: undefined } },
        git: tableGit({ [DIFF]: nameStatus({ 'src/a.ts': 'M' }) }),
      });
      expect(await anonymous.code).toBe(1);
    });
  });

  describe('in a GitLab merge request pipeline', () => {
    const ENV = {
      GITLAB_CI: 'true',
      CI_SERVER_URL: 'https://gitlab.example.com',
      CI_PROJECT_ID: '42',
      CI_PROJECT_URL: 'https://gitlab.example.com/group/project',
      CI_JOB_TOKEN: 'job',
      CI_MERGE_REQUEST_IID: '7',
      CI_MERGE_REQUEST_LABELS: '',
      CI_MERGE_REQUEST_DIFF_BASE_SHA: 'base',
    };

    it('reads the labels from the variables, with no API call', async () => {
      const fetchImpl = routeFetch({});
      const { code } = run(['--require-paths', 'src/**'], {
        env: { ...ENV, CI_MERGE_REQUEST_LABELS: 'no-changelog' },
        fetch: fetchImpl,
      });
      expect(await code).toBe(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reads the author from the API only for skip-authors', async () => {
      const fetchImpl = routeFetch({
        '/api/v4/projects/42/merge_requests/7': { iid: 7, author: { username: 'foxy' } },
      });
      const bot = run(['--require-paths', 'src/**', '--skip-authors', 'foxy'], {
        env: ENV,
        fetch: fetchImpl,
      });
      expect(await bot.code).toBe(0);

      const human = run(['--require-paths', 'src/**', '--codequality', 'cq.json'], {
        env: ENV,
        fetch: fetchImpl,
        git: tableGit({ [DIFF]: nameStatus({ 'src/a.ts': 'M' }) }),
      });
      expect(await human.code).toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(human.runtime.err).toEqual([
        '.changelog:1: This merge request changes 1 file(s) matching src/** (e.g. src/a.ts) but adds no fragment in .changelog/. Add one, or set the "no-changelog" label.',
      ]);
      const report = JSON.parse(readFileSync(join(human.cwd, 'cq.json'), 'utf8'));
      expect(report[0].check_name).toBe('changelog-missing-fragment');
    });
  });
});
