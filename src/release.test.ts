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
    expect(read('release.env')).toBe(
      'CHANGELOG_CHANGED=false\nCHANGELOG_VERSION=1.1.0\nCHANGELOG_PRERELEASE=false\nCHANGELOG_DIST_TAG=latest\n',
    );
    expect(read('notes.md')).toBe('');
    expect(read('github-output')).toMatch(
      /^changed<<(\S+)\nfalse\n\1\nversion<<(\S+)\n1\.1\.0\n\2\nprerelease<<(\S+)\nfalse\n\3\ndist-tag<<(\S+)\nlatest\n\4\nbody<<(\S+)\n\n\5\n$/,
    );
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
        'tag --merged HEAD': '',
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
      '- Fix a ([#12])',
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
          'tag --merged HEAD': '1\nv0.9.0\nv1.0.0\n',
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
        '- Nouveau ([!3])',
        '',
        '### Dépendances',
        '',
        '- Update x ([!4])',
        '',
        '[!3]: https://gitlab.example.com/group/project/-/merge_requests/3',
        '[!4]: https://gitlab.example.com/group/project/-/merge_requests/4',
        '',
        '## 1.0.0',
      ].join('\n'),
    );
    expect(read('out/release.env')).toBe(
      'CHANGELOG_CHANGED=true\nCHANGELOG_VERSION=v2.0.0\nCHANGELOG_PRERELEASE=false\nCHANGELOG_DIST_TAG=latest\n',
    );
  });

  it('computes the next version with --version auto and --current', async () => {
    const { runtime, read, code } = run(
      ['--version', 'auto', '--current', '1.1.0', '--dotenv', 'release.env'],
      {
        files: { '.changelog/a.md': '### Added\n- A\n### Fixed\n- B\n' },
        git: tableGit({ [added('.changelog/a.md')]: '', 'tag --merged HEAD': '1.1.0\n' }),
      },
    );
    expect(await code).toBe(0);
    expect(runtime.out[0]).toBe('Version 1.2.0: feature change since 1.1.0.');
    expect(read('CHANGELOG.md')).toContain('## 1.2.0 - 2026-10-12\n\n### Added\n\n- A\n');
    expect(read('release.env')).toBe(
      'CHANGELOG_CHANGED=true\nCHANGELOG_VERSION=1.2.0\nCHANGELOG_PRERELEASE=false\nCHANGELOG_DIST_TAG=latest\n',
    );
    expect(read('github-output')).toMatch(/\nversion<<(\S+)\n1\.2\.0\n\1\n/);
  });

  it('bumps from the latest version tag, from CHANGELOG_CURRENT_VERSION, or from 0.0.0', async () => {
    const fragment = { '.changelog/a.md': '### Changed\n- **CLI**: Breaking: rename\n' };
    const tagged = run(['--version', 'auto'], {
      files: fragment,
      git: tableGit({ [added('.changelog/a.md')]: '', 'tag --merged HEAD': '1\n1.4.0\n' }),
    });
    expect(await tagged.code).toBe(0);
    expect(tagged.read('CHANGELOG.md')).toContain('## 2.0.0 - 2026-10-12');

    const fromEnv = run(['--version', 'auto'], {
      env: { CHANGELOG_CURRENT_VERSION: '0.4.7' },
      files: fragment,
      git: tableGit({ [added('.changelog/a.md')]: '', 'tag --merged HEAD': '0.4.7\n' }),
    });
    expect(await fromEnv.code).toBe(0);
    expect(fromEnv.read('CHANGELOG.md')).toContain('## 0.5.0 - 2026-10-12');

    const untagged = run(['--version', 'auto'], {
      files: { '.changelog/a.md': '### Fixed\n- Fix\n' },
      git: tableGit({ [added('.changelog/a.md')]: '', 'tag --merged HEAD': '' }),
    });
    expect(await untagged.code).toBe(0);
    expect(untagged.read('CHANGELOG.md')).toContain('## 0.0.1 - 2026-10-12');
  });

  it('releases a minor version for a breaking change on 0.x', async () => {
    const { read, code } = run(['--version', 'auto', '--current', '0.9.9'], {
      files: {
        '.changelog/sse.md': '### Removed\n\n- **BREAKING**: Remove the `sse` MCP transport\n',
      },
      git: tableGit({ [added('.changelog/sse.md')]: '', 'tag --merged HEAD': '0\n0.9.9\n' }),
    });
    expect(await code).toBe(0);
    expect(read('CHANGELOG.md')).toContain('## 0.10.0 - 2026-10-12\n\n### Removed\n');
  });

  it('releases a patch for entries from skip-authors alone', async () => {
    const { read, code } = run(['--version', 'auto', '--current', '1.1.0'], {
      env: GITHUB,
      git: tableGit({
        'tag --merged HEAD': '1\n1.1.0\n',
        'log --first-parent --format=%H 1.1.0..HEAD': 'c1\n',
      }),
      fetch: routeFetch({
        '/repos/acme/repo/commits/c1/pulls': [
          {
            number: 7,
            title: 'chore(deps): update x',
            merged_at: '2026-10-12',
            base: { ref: 'main' },
            user: { login: 'renovate[bot]' },
          },
        ],
      }),
    });
    expect(await code).toBe(0);
    expect(read('CHANGELOG.md')).toContain(
      '## 1.1.1 - 2026-10-12\n\n### Dependencies\n\n- Update x ([#7])',
    );
  });

  it('bumps the current version with --version patch, minor or major', async () => {
    const { runtime, read, code } = run(['--version', 'major', '--dotenv', 'release.env'], {
      files: { '.changelog/a.md': '### Fixed\n- Fix\n' },
      git: tableGit({ [added('.changelog/a.md')]: '', 'tag --merged HEAD': '1\n1.1.0\n' }),
    });
    expect(await code).toBe(0);
    expect(runtime.out[0]).toBe('Version 2.0.0: major bump since 1.1.0.');
    expect(read('CHANGELOG.md')).toContain('## 2.0.0 - 2026-10-12\n\n### Fixed\n\n- Fix\n');
    expect(read('release.env')).toBe(
      'CHANGELOG_CHANGED=true\nCHANGELOG_VERSION=2.0.0\nCHANGELOG_PRERELEASE=false\nCHANGELOG_DIST_TAG=latest\n',
    );
  });

  it('writes an empty version when a bump has nothing to release', async () => {
    const { read, code } = run(['--version', 'minor', '--skip-authors', ''], {
      git: tableGit({ 'tag --merged HEAD': '1.0.0\n' }),
    });
    expect(await code).toBe(0);
    expect(read('CHANGELOG.md')).toBe(CHANGELOG);
    expect(read('github-output')).toMatch(/\nversion<<(\S+)\n\n\1\n/);
  });

  it('writes an empty version when --version auto has nothing to release', async () => {
    const { read, code } = run(
      ['--version', 'auto', '--dotenv', 'release.env', '--skip-authors', ''],
      { git: tableGit({ 'tag --merged HEAD': '1.0.0\n' }) },
    );
    expect(await code).toBe(0);
    expect(read('CHANGELOG.md')).toBe(CHANGELOG);
    expect(read('release.env')).toBe(
      'CHANGELOG_CHANGED=false\nCHANGELOG_VERSION=\nCHANGELOG_PRERELEASE=false\nCHANGELOG_DIST_TAG=\n',
    );
    expect(read('github-output')).toMatch(
      /\nversion<<(\S+)\n\n\1\nprerelease<<(\S+)\nfalse\n\2\ndist-tag<<(\S+)\n\n\3\n/,
    );
  });

  it('reads a given version with a hyphen in its build metadata as stable', async () => {
    const { read, code } = run(['--version', '1.2.0+build-1', '--dotenv', 'release.env'], {
      files: { '.changelog/a.md': '### Fixed\n- Fix\n' },
      git: tableGit({ [added('.changelog/a.md')]: '' }),
    });
    expect(await code).toBe(0);
    expect(read('release.env')).toBe(
      'CHANGELOG_CHANGED=true\nCHANGELOG_VERSION=1.2.0+build-1\nCHANGELOG_PRERELEASE=false\nCHANGELOG_DIST_TAG=latest\n',
    );
  });

  describe('with --version calver', () => {
    it('releases the next version of the month, in French with a heading prefix', async () => {
      const { runtime, read, code } = run(
        [
          '--version',
          'calver',
          '--locale',
          'fr',
          '--heading-prefix',
          'v',
          '--dotenv',
          'release.env',
        ],
        {
          files: {
            '.changelog/a.md': '### Corrigé\n- Corrige A\n',
            '.changelog/prerelease': 'rc\n',
          },
          git: tableGit({
            [added('.changelog/a.md')]: '',
            'tag --merged HEAD': '2026.x\n2026.9.4\n2026.10.0\n2026.10.1\n',
          }),
        },
      );
      expect(await code).toBe(0);
      expect(runtime.out[0]).toBe('Version 2026.10.2: CalVer of 2026-10-12.');
      expect(read('CHANGELOG.md')).toContain(
        '## v2026.10.2 - 2026-10-12\n\n### Corrigé\n\n- Corrige A\n\n## 1.0.0',
      );
      expect(read('release.env')).toBe(
        'CHANGELOG_CHANGED=true\nCHANGELOG_VERSION=2026.10.2\nCHANGELOG_PRERELEASE=false\nCHANGELOG_DIST_TAG=latest\n',
      );
      expect(read('.changelog/prerelease')).toBe('rc\n');
    });

    it('releases nothing without entries', async () => {
      const { read, code } = run(
        ['--version', 'calver', '--dotenv', 'release.env', '--skip-authors', ''],
        { git: tableGit({ 'tag --merged HEAD': '2026.10.0\n' }) },
      );
      expect(await code).toBe(0);
      expect(read('CHANGELOG.md')).toBe(CHANGELOG);
      expect(read('release.env')).toBe(
        'CHANGELOG_CHANGED=false\nCHANGELOG_VERSION=\nCHANGELOG_PRERELEASE=false\nCHANGELOG_DIST_TAG=\n',
      );
    });

    it('refuses a version that the changelog already has, with its prefix', async () => {
      const { code } = run(['--version', 'calver', '--heading-prefix', 'v'], {
        files: {
          'CHANGELOG.md': '# Changelog\n\n## v2026.10.0 - 2026-10-01\n',
          '.changelog/a.md': '### Fixed\n- Fix\n',
        },
        git: tableGit({ [added('.changelog/a.md')]: '', 'tag --merged HEAD': '' }),
      });
      await expect(code).rejects.toThrow('CHANGELOG.md already has a section for v2026.10.0.');
    });
  });

  describe('with --version auto and .changelog/prerelease', () => {
    const tags = (list: string) => ({ 'tag --merged HEAD': list });

    it('starts a prerelease from a stable version, with the next dist-tag', async () => {
      const { runtime, read, cwd, code } = run(
        ['--version', 'auto', '--current', '1.1.0', '--dotenv', 'release.env'],
        {
          files: { '.changelog/prerelease': 'rc\n', '.changelog/a.md': '### Added\n- A\n' },
          git: tableGit({ [added('.changelog/a.md')]: '', ...tags('1\n1.1.0\n') }),
        },
      );
      expect(await code).toBe(0);
      expect(runtime.out[0]).toBe(
        'Version 1.2.0-rc.0: feature change since 1.1.0 (prerelease "rc").',
      );
      expect(read('CHANGELOG.md')).toContain('## 1.2.0-rc.0 - 2026-10-12\n\n### Added\n\n- A\n');
      expect(existsSync(join(cwd, '.changelog/a.md'))).toBe(false);
      expect(read('.changelog/prerelease')).toBe('rc\n');
      expect(read('release.env')).toBe(
        'CHANGELOG_CHANGED=true\nCHANGELOG_VERSION=1.2.0-rc.0\nCHANGELOG_PRERELEASE=true\nCHANGELOG_DIST_TAG=next\n',
      );
      expect(read('github-output')).toMatch(
        /\nprerelease<<(\S+)\ntrue\n\1\ndist-tag<<(\S+)\nnext\n\2\n/,
      );
    });

    it('moves from beta to rc, and to a major prerelease for a breaking entry', async () => {
      const toRc = run(['--version', 'auto', '--current', '1.2.0-beta.3'], {
        files: { '.changelog/prerelease': 'rc', '.changelog/a.md': '### Fixed\n- A\n' },
        git: tableGit({ [added('.changelog/a.md')]: '', ...tags('1.1.0\n1.2.0-beta.3\n') }),
      });
      expect(await toRc.code).toBe(0);
      expect(toRc.read('CHANGELOG.md')).toContain('## 1.2.0-rc.0 - 2026-10-12');

      const breaking = run(['--version', 'auto'], {
        files: { '.changelog/prerelease': 'rc', '.changelog/a.md': '### Changed\n- ⚠️ B\n' },
        git: tableGit({ [added('.changelog/a.md')]: '', ...tags('1.1.0\n1.2.0-rc.1\n') }),
      });
      expect(await breaking.code).toBe(0);
      expect(breaking.read('CHANGELOG.md')).toContain('## 2.0.0-rc.0 - 2026-10-12');
    });

    it('releases nothing in prerelease mode without entries', async () => {
      const { read, code } = run(['--version', 'auto', '--skip-authors', ''], {
        files: { '.changelog/prerelease': 'rc\n' },
        git: tableGit(tags('1.1.0\n1.2.0-rc.0\n')),
      });
      expect(await code).toBe(0);
      expect(read('CHANGELOG.md')).toBe(CHANGELOG);
      expect(read('github-output')).toMatch(/^changed<<(\S+)\nfalse\n/);
    });

    it('promotes a prerelease without entries when the file is gone, in French too', async () => {
      const { runtime, read, code } = run(
        ['--version', 'auto', '--skip-authors', '', '--notes-file', 'notes.md'],
        { git: tableGit(tags('1\n1.1.0\n1.2.0-rc.2\n')) },
      );
      expect(await code).toBe(0);
      expect(runtime.out[0]).toBe('Version 1.2.0: stable release of 1.2.0-rc.2.');
      expect(read('CHANGELOG.md')).toContain(
        '## 1.2.0 - 2026-10-12\n\nStable release of 1.2.0-rc.2.\n\n## 1.0.0',
      );
      expect(read('notes.md')).toBe('Stable release of 1.2.0-rc.2.\n');
      expect(read('github-output')).toMatch(/^changed<<(\S+)\ntrue\n\1\nversion<<(\S+)\n1\.2\.0\n/);

      const french = run(['--version', 'auto', '--locale', 'fr', '--skip-authors', ''], {
        git: tableGit(tags('1.1.0\n1.2.0-rc.2\n')),
      });
      expect(await french.code).toBe(0);
      expect(french.read('CHANGELOG.md')).toContain(
        '## 1.2.0 - 2026-10-12\n\nVersion stable de 1.2.0-rc.2.\n',
      );
    });

    it('promotes a prerelease with its new entries', async () => {
      const { read, code } = run(['--version', 'auto', '--current', '1.2.0-rc.2'], {
        files: { '.changelog/a.md': '### Fixed\n- Last fix\n' },
        git: tableGit({ [added('.changelog/a.md')]: '', ...tags('1.1.0\n1.2.0-rc.2\n') }),
      });
      expect(await code).toBe(0);
      expect(read('CHANGELOG.md')).toContain('## 1.2.0 - 2026-10-12\n\n### Fixed\n\n- Last fix\n');
      expect(read('CHANGELOG.md')).not.toContain('Stable release');
    });

    it('counts entries from skip-authors in prerelease mode', async () => {
      const { read, code } = run(['--version', 'auto', '--current', '1.2.0-rc.0'], {
        env: GITHUB,
        files: { '.changelog/prerelease': 'rc\n' },
        git: tableGit({
          ...tags('1.1.0\n1.2.0-rc.0\n'),
          'log --first-parent --format=%H 1.2.0-rc.0..HEAD': 'c1\n',
        }),
        fetch: routeFetch({
          '/repos/acme/repo/commits/c1/pulls': [
            {
              number: 8,
              title: 'chore(deps): update y',
              merged_at: '2026-10-12',
              base: { ref: 'main' },
              user: { login: 'renovate[bot]' },
            },
          ],
        }),
      });
      expect(await code).toBe(0);
      expect(read('CHANGELOG.md')).toContain('## 1.2.0-rc.1 - 2026-10-12\n\n### Dependencies\n');
    });

    it('changes nothing when the prerelease file is invalid', async () => {
      const { runtime, read, code } = run(['--version', 'auto'], {
        files: {
          '.changelog/prerelease': 'release candidate\n',
          '.changelog/a.md': '### Added\n- A\n',
        },
      });
      expect(await code).toBe(1);
      expect(runtime.err.slice(1)).toEqual([
        '.changelog/prerelease:1: "release candidate" is not a valid prerelease identifier. Use letters, digits and hyphens, not only digits (alpha, beta, rc).',
        'Invalid .changelog/prerelease: CHANGELOG.md and .changelog/ are unchanged.',
      ]);
      expect(read('.changelog/a.md')).toBe('### Added\n- A\n');
    });

    it('ignores the prerelease file with an explicit version', async () => {
      const { read, code } = run(['--version', '1.2.0', '--skip-authors', ''], {
        files: { '.changelog/prerelease': '', '.changelog/a.md': '### Added\n- A\n' },
        git: tableGit({ [added('.changelog/a.md')]: '' }),
      });
      expect(await code).toBe(0);
      expect(read('CHANGELOG.md')).toContain('## 1.2.0 - 2026-10-12');
      expect(read('.changelog/prerelease')).toBe('');
    });
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
