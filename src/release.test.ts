import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { GitLabApiError } from './errors.js';
import type { Git } from './git.js';
import { createPlatform } from './platform.js';
import { release } from './release.js';
import { makeDirectory, makeRuntime, routeFetch, tableGit } from './test-utils.js';

const CHANGELOG = '# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- First\n';

const GITHUB = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'acme/repo',
  GITHUB_REF: 'refs/heads/main',
};

const GITLAB = {
  GITLAB_CI: 'true',
  CI_SERVER_URL: 'https://gitlab.example.com',
  CI_PROJECT_ID: '42',
  CI_PROJECT_URL: 'https://gitlab.example.com/group/project',
  CI_JOB_TOKEN: 'job',
  CI_COMMIT_BRANCH: 'main',
};

function added(file: string): string {
  return `log --diff-filter=A --format=%H %ct -1 -- ${file}`;
}

function run(
  argv: string[],
  options: {
    files?: Record<string, string>;
    env?: Record<string, string>;
    git?: Git;
    fetch?: typeof fetch;
  } = {},
) {
  const cwd = makeDirectory({
    'CHANGELOG.md': CHANGELOG,
    '.changelog/.gitkeep': '',
    ...options.files,
  });
  const env = { ...options.env, GITHUB_OUTPUT: join(cwd, 'github-output') };
  const config = resolveConfig(['release', '--date', '2026-10-12', ...argv], env);
  const runtime = makeRuntime(cwd, {
    env,
    ...(options.git ? { git: options.git } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const read = (path: string) => readFileSync(join(cwd, path), 'utf8');
  return {
    cwd,
    runtime,
    read,
    code: release(config, createPlatform(config, runtime.fetch), runtime),
  };
}

describe('release', () => {
  it('changes nothing without fragments, and says so in every output', async () => {
    const { runtime, read, code } = run(
      [
        '--version',
        '1.1.0',
        '--dotenv',
        'release.env',
        '--notes-file',
        'notes.md',
        '--skip-authors',
        '',
      ],
      { files: { '.changelog/empty.md': '\n' } },
    );
    expect(await code).toBe(0);
    expect(runtime.err).toEqual([
      'Warning: GITHUB_REPOSITORY is not set: no pull request references and no entries from skip-authors.',
    ]);
    expect(runtime.out).toEqual([
      'No fragment in .changelog/ and no pull request from skip-authors: CHANGELOG.md is unchanged.',
    ]);
    expect(read('CHANGELOG.md')).toBe(CHANGELOG);
    expect(read('.changelog/empty.md')).toBe('\n');
    expect(read('release.env')).toBe('CHANGELOG_CHANGED=false\nCHANGELOG_VERSION=1.1.0\n');
    expect(read('notes.md')).toBe('');
    expect(read('github-output')).toMatch(/^changed<<(\S+)\nfalse\n\1\nbody<<(\S+)\n\n\2\n$/);
  });

  it('folds fragments with pull request references, oldest first, and deletes them', async () => {
    const { runtime, read, cwd, code } = run(['--version', '1.1.0', '--notes-file', 'notes.md'], {
      env: GITHUB,
      files: {
        '.changelog/a.md': '### Fixed\n\n- Fix a\n',
        '.changelog/b.md': '### Added\n\n- Add b\n',
        '.changelog/local.md': '### Fixed\n\n- Fix local\n',
      },
      git: tableGit({
        [added('.changelog/a.md')]: 'sha-a 200\n',
        [added('.changelog/b.md')]: 'sha-b 100\n',
        [added('.changelog/local.md')]: '',
        'describe --tags --abbrev=0 HEAD': new Error('No names found'),
      }),
      fetch: routeFetch({
        '/repos/acme/repo/commits/sha-a/pulls': [
          { number: 12, title: 'A', merged_at: '2026-01-02', base: { ref: 'main' } },
        ],
        '/repos/acme/repo/commits/sha-b/pulls': [],
      }),
    });
    expect(await code).toBe(0);
    const body = [
      '### Added',
      '',
      '- Add b',
      '',
      '### Fixed',
      '',
      '- Fix a [[#12]]',
      '- Fix local',
      '',
      '[#12]: https://github.com/acme/repo/pull/12',
    ].join('\n');
    expect(runtime.out).toEqual([
      'No previous tag: no pull request from skip-authors to add.',
      `## 1.1.0 - 2026-10-12\n\n${body}`,
    ]);
    expect(read('CHANGELOG.md')).toBe(
      `# Changelog\n\n## 1.1.0 - 2026-10-12\n\n${body}\n\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- First\n`,
    );
    expect(existsSync(join(cwd, '.changelog/a.md'))).toBe(false);
    expect(existsSync(join(cwd, '.changelog/.gitkeep'))).toBe(true);
    expect(read('notes.md')).toBe(`${body}\n`);
    expect(read('github-output')).toContain(`\ntrue\n`);
  });

  it('adds the merge requests of skip-authors since the previous tag on GitLab, in French', async () => {
    const fetchImpl = routeFetch({
      '/api/v4/projects/42/repository/commits/sha-frag/merge_requests': [
        {
          iid: 3,
          title: 'Feature',
          state: 'merged',
          target_branch: 'main',
          author: { username: 'dev' },
        },
      ],
      '/api/v4/projects/42/repository/commits/c1/merge_requests': [
        {
          iid: 3,
          title: 'Feature',
          state: 'merged',
          target_branch: 'main',
          author: { username: 'dev' },
        },
      ],
      '/api/v4/projects/42/repository/commits/c2/merge_requests': [
        {
          iid: 4,
          title: 'chore(deps): update x',
          state: 'merged',
          target_branch: 'main',
          author: { username: 'foxy' },
        },
      ],
      '/api/v4/projects/42/repository/commits/c3/merge_requests': [
        {
          iid: 4,
          title: 'chore(deps): update x',
          state: 'merged',
          target_branch: 'main',
          author: { username: 'foxy' },
        },
      ],
      '/api/v4/projects/42/repository/commits/c4/merge_requests': [
        {
          iid: 5,
          title: 'Dev deps',
          state: 'merged',
          target_branch: 'main',
          author: { username: 'foxy' },
          labels: ['no-changelog'],
        },
      ],
      '/api/v4/projects/42/repository/commits/c5/merge_requests': [
        { iid: 6, title: 'Anonymous', state: 'merged', target_branch: 'main' },
      ],
      '/api/v4/projects/42/repository/commits/c6/merge_requests': [],
    });
    const { read, code } = run(
      [
        '--version',
        'v2.0.0',
        '--locale',
        'fr',
        '--skip-authors',
        'foxy',
        '--dotenv',
        'out/release.env',
      ],
      {
        env: GITLAB,
        files: { '.changelog/feature.md': '### Ajouté\n\n- Nouveau\n' },
        fetch: fetchImpl,
        git: tableGit({
          [added('.changelog/feature.md')]: 'sha-frag 100\n',
          'describe --tags --abbrev=0 HEAD': 'v1.0.0\n',
          'log --first-parent --format=%H v1.0.0..HEAD': 'c6\nc5\nc4\nc3\nc2\nc1\n',
        }),
      },
    );
    expect(await code).toBe(0);
    expect(read('CHANGELOG.md')).toContain(
      [
        '## v2.0.0 - 2026-10-12',
        '',
        '### Ajouté',
        '',
        '- Nouveau [[!3]]',
        '',
        '### Dépendances',
        '',
        '- Update x [[!4]]',
        '',
        '[!3]: https://gitlab.example.com/group/project/-/merge_requests/3',
        '[!4]: https://gitlab.example.com/group/project/-/merge_requests/4',
        '',
        '## 1.0.0',
      ].join('\n'),
    );
    expect(read('out/release.env')).toBe('CHANGELOG_CHANGED=true\nCHANGELOG_VERSION=v2.0.0\n');
  });

  it('folds fragments without references when the API is unavailable', async () => {
    const { read, code } = run(['--version', '1.1.0'], {
      files: { '.changelog/b.md': '### Added\n- B\n', '.changelog/a.md': '### Added\n- A\n' },
      git: tableGit({
        [added('.changelog/a.md')]: 'sha 100\n',
        [added('.changelog/b.md')]: 'sha 100\n',
      }),
    });
    expect(await code).toBe(0);
    expect(read('CHANGELOG.md')).toContain('### Added\n\n- A\n- B\n\n## 1.0.0');
  });

  it('changes nothing when a fragment is invalid', async () => {
    const { runtime, read, code } = run(['--version', '1.1.0', '--skip-authors', ''], {
      files: { '.changelog/a.md': '## Oops\n' },
      git: tableGit({ [added('.changelog/a.md')]: '' }),
    });
    expect(await code).toBe(1);
    expect(runtime.err.slice(1)).toEqual([
      '.changelog/a.md:1: Heading "## Oops" is not allowed. A fragment only contains "### <Section>" headings.',
      'Invalid fragments: CHANGELOG.md and .changelog/ are unchanged.',
    ]);
    expect(read('.changelog/a.md')).toBe('## Oops\n');
    expect(read('CHANGELOG.md')).toBe(CHANGELOG);
  });

  it('needs a CHANGELOG.md', async () => {
    const cwd = makeDirectory({ '.changelog/a.md': '### Added\n- A\n' });
    const config = resolveConfig(['release', '--version', '1', '--skip-authors', ''], {});
    const runtime = makeRuntime(cwd, { git: tableGit({ [added('.changelog/a.md')]: '' }) });
    await expect(release(config, createPlatform(config, runtime.fetch), runtime)).rejects.toThrow(
      'CHANGELOG.md not found.',
    );
  });

  it('stops on an API error', async () => {
    const { code } = run(['--version', '1.1.0'], {
      env: GITLAB,
      files: { '.changelog/a.md': '### Added\n- A\n' },
      git: tableGit({ [added('.changelog/a.md')]: 'sha 1\n' }),
      fetch: routeFetch({
        '/api/v4/projects/42/repository/commits/sha/merge_requests': new Response('', {
          status: 401,
        }),
      }),
    });
    await expect(code).rejects.toBeInstanceOf(GitLabApiError);
  });
});
