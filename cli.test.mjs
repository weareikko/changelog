import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main, parseArgs } from './cli.mjs';

/** Build a temporary project and an Io that records everything. */
function setup({ fragments = {}, changelog = '# Changelog\n\n## 0.1.0 - 2026-01-01\n\n- Old\n', env = {}, routes = {}, commits = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'changelog-'));
  mkdirSync(join(cwd, '.changelog'));
  writeFileSync(join(cwd, '.changelog/.gitkeep'), '');
  for (const [name, text] of Object.entries(fragments)) writeFileSync(join(cwd, '.changelog', name), text);
  if (changelog !== null) writeFileSync(join(cwd, 'CHANGELOG.md'), changelog);

  const io = {
    cwd,
    env: { GITHUB_REPOSITORY: 'acme/repo', ...env },
    logs: [],
    errors: [],
    requests: [],
    log: (message) => io.logs.push(message),
    error: (message) => io.errors.push(message),
    git: (args) => commits[args.at(-1)] ?? '',
    fetch: async (url, init) => {
      io.requests.push({ url, init });
      const path = url.replace(/^(https:\/\/api\.github\.com|https:\/\/gitlab\.test\/api\/v4)/, '');
      if (!(path in routes)) return { ok: false, status: 404 };
      return { ok: true, json: async () => routes[path] };
    },
  };
  return io;
}

const GITLAB = {
  GITLAB_CI: 'true',
  CI_API_V4_URL: 'https://gitlab.test/api/v4',
  CI_PROJECT_ID: '42',
  CI_PROJECT_URL: 'https://gitlab.test/acme/repo',
  GITLAB_TOKEN: 'glpat-secret',
};

function writeEvent(io, pullRequest) {
  const path = join(io.cwd, 'event.json');
  writeFileSync(path, JSON.stringify({ pull_request: pullRequest }));
  io.env.GITHUB_EVENT_PATH = path;
}

describe('parseArgs', () => {
  it('reads the command and options', () => {
    assert.deepEqual(parseArgs(['release', '--version', '1.0.0']), { command: 'release', options: { version: '1.0.0' } });
  });

  it('reads an option without value as empty', () => {
    assert.deepEqual(parseArgs(['check', '--require-paths']), { command: 'check', options: { 'require-paths': '' } });
  });

  it('rejects positional arguments', () => {
    assert.throws(() => parseArgs(['check', 'oops']), /Unexpected argument "oops"/);
  });
});

describe('main', () => {
  it('prints usage for an unknown command', async () => {
    const io = setup();
    assert.equal(await main(['nope'], io), 2);
    assert.match(io.errors[0], /^Usage:/);
  });

  it('prints usage on request', async () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const io = setup();
      assert.equal(await main(argv, io), 0);
      assert.match(io.logs[0], /^Usage: changelog check/);
      assert.deepEqual(io.errors, []);
    }
  });

  it('rejects an unknown locale or platform', async () => {
    let io = setup();
    assert.equal(await main(['check', '--locale', 'de'], io), 1);
    assert.equal(io.errors[0], 'Unknown locale "de". Use en or fr.');
    io = setup();
    assert.equal(await main(['check', '--locale', 'constructor'], io), 1);
    io = setup();
    assert.equal(await main(['release', '--version', '1.0.0', '--platform', 'bitbucket'], io), 1);
    assert.equal(io.errors[0], 'Unknown platform "bitbucket". Use github or gitlab.');
  });

  it('fails without a .changelog directory', async () => {
    const io = setup();
    io.cwd = mkdtempSync(join(tmpdir(), 'changelog-empty-'));
    assert.equal(await main(['check'], io), 1);
    assert.match(io.errors[0], /No \.changelog\/ directory/);
  });
});

describe('check', () => {
  it('accepts valid fragments', async () => {
    const io = setup({ fragments: { 'a.md': '### Added\n- A\n' } });
    assert.equal(await main(['check'], io), 0);
    assert.deepEqual(io.logs, ['1 fragment(s) valid.']);
  });

  it('reports invalid fragments as plain errors', async () => {
    const io = setup({ fragments: { 'a.md': '## Oops\n' } });
    assert.equal(await main(['check'], io), 1);
    assert.match(io.errors[0], /^\.changelog\/a\.md:1: Heading "## Oops"/);
  });

  it('validates the sections of the given locale', async () => {
    const io = setup({ fragments: { 'a.md': '### Ajouté\n- A\n', 'b.md': '### Added\n- B\n' } });
    assert.equal(await main(['check', '--locale', 'fr'], io), 1);
    assert.deepEqual(io.errors, [
      '.changelog/b.md:1: Unknown section "Added". Use one of: Ajouté, Modifié, Déprécié, Supprimé, Corrigé, Sécurité, Dépendances.',
      '.changelog/b.md:2: Line "- B" is outside of any section. A fragment starts with a "### <Section>" heading.',
    ]);
  });

  it('reports invalid fragments as GitHub annotations', async () => {
    const io = setup({ fragments: { 'a.md': '- Oops 100%\n' }, env: { GITHUB_ACTIONS: 'true' } });
    assert.equal(await main(['check'], io), 1);
    assert.match(io.errors[0], /^::error file=\.changelog\/a\.md,line=1::Line "- Oops 100%25"/);
  });

  describe('on a pull request', () => {
    let io;
    const files = (list) => ({ '/repos/acme/repo/pulls/7/files?per_page=100&page=1': list });

    it('does nothing without require-paths', async () => {
      io = setup();
      writeEvent(io, { number: 7, labels: [] });
      assert.equal(await main(['check'], io), 0);
      assert.equal(io.requests.length, 0);
    });

    it('fails when matching files change without a fragment', async () => {
      io = setup({ routes: files([{ filename: 'packages/cli/a.ts', status: 'modified' }, { filename: '.changelog/.gitkeep', status: 'added' }]) });
      writeEvent(io, { number: 7, labels: [] });
      assert.equal(await main(['check', '--require-paths', 'packages/**\nsrc/**'], io), 1);
      assert.match(io.errors[0], /changes 1 file\(s\) matching packages\/\*\*, src\/\*\* \(e\.g\. packages\/cli\/a\.ts\) but adds no fragment/);
      assert.match(io.errors[0], /"no-changelog" label/);
    });

    it('passes when a fragment is added', async () => {
      io = setup({ routes: files([{ filename: 'packages/cli/a.ts', status: 'modified' }, { filename: '.changelog/a.md', status: 'added' }]) });
      writeEvent(io, { number: 7, labels: [] });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 0);
    });

    it('does not count a removed or nested fragment', async () => {
      io = setup({
        routes: files([
          { filename: 'packages/a.ts', status: 'modified' },
          { filename: '.changelog/old.md', status: 'removed' },
          { filename: '.changelog/sub/a.md', status: 'added' },
        ]),
      });
      writeEvent(io, { number: 7, labels: [] });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 1);
    });

    it('passes when no file matches', async () => {
      io = setup({ routes: files([{ filename: 'README.md', status: 'modified' }]) });
      writeEvent(io, { number: 7, labels: [] });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 0);
    });

    it('skips the requirement with the skip label', async () => {
      io = setup();
      writeEvent(io, { number: 7, labels: [{ name: 'internal' }] });
      assert.equal(await main(['check', '--require-paths', 'packages/**', '--skip-label', 'internal'], io), 0);
      assert.equal(io.logs[1], 'Label "internal" is set: no fragment required.');
      assert.equal(io.requests.length, 0);
    });

    it('skips the requirement for renovate[bot] by default', async () => {
      io = setup();
      writeEvent(io, { number: 7, labels: [], user: { login: 'renovate[bot]' } });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 0);
      assert.equal(io.logs[1], 'Author "renovate[bot]" is in skip-authors: no fragment required.');
      assert.equal(io.requests.length, 0);
    });

    it('skips the requirement for the authors in skip-authors', async () => {
      io = setup();
      writeEvent(io, { number: 7, labels: [], user: { login: 'bot-b' } });
      assert.equal(await main(['check', '--require-paths', 'packages/**', '--skip-authors', 'bot-a,\nbot-b'], io), 0);
      assert.equal(io.requests.length, 0);
    });

    it('requires a fragment from renovate[bot] when skip-authors is empty', async () => {
      io = setup({ routes: files([{ filename: 'packages/a.ts', status: 'modified' }]) });
      writeEvent(io, { number: 7, labels: [], user: { login: 'renovate[bot]' } });
      assert.equal(await main(['check', '--require-paths', 'packages/**', '--skip-authors', ''], io), 1);
      assert.match(io.errors[0], /adds no fragment/);
    });

    it('still validates the fragments of skip-authors', async () => {
      io = setup({ fragments: { 'deps.md': '## Oops\n' } });
      writeEvent(io, { number: 7, labels: [], user: { login: 'renovate[bot]' } });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 1);
      assert.match(io.errors[0], /Heading "## Oops"/);
    });

    it('reads every page of files and sends the token', async () => {
      const page1 = Array.from({ length: 100 }, (_, index) => ({ filename: `docs/${index}.md`, status: 'added' }));
      io = setup({
        env: { GITHUB_TOKEN: 'secret' },
        routes: {
          '/repos/acme/repo/pulls/7/files?per_page=100&page=1': page1,
          '/repos/acme/repo/pulls/7/files?per_page=100&page=2': [{ filename: 'packages/a.ts', status: 'modified' }],
        },
      });
      writeEvent(io, { number: 7, labels: [] });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 1);
      assert.equal(io.requests.length, 2);
      assert.equal(io.requests[0].init.headers.Authorization, 'Bearer secret');
    });

    it('fails when the API fails', async () => {
      io = setup();
      writeEvent(io, { number: 7, labels: [] });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 1);
      assert.match(io.errors[0], /answered 404/);
    });

    it('fails without GITHUB_REPOSITORY', async () => {
      io = setup();
      delete io.env.GITHUB_REPOSITORY;
      writeEvent(io, { number: 7, labels: [] });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 1);
      assert.deepEqual(io.errors, ['GITHUB_REPOSITORY is not set: cannot read pull requests from the GitHub API.']);
      assert.equal(io.requests.length, 0);
    });
  });

  it('requires nothing outside a pull request', async () => {
    let io = setup();
    assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 0);
    io = setup();
    const path = join(io.cwd, 'event.json');
    writeFileSync(path, JSON.stringify({ ref: 'refs/heads/main' }));
    io.env.GITHUB_EVENT_PATH = path;
    assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 0);
    assert.equal(io.requests.length, 0);
  });

  describe('on a GitLab merge request', () => {
    const diffs = (list) => ({ '/projects/42/merge_requests/7/diffs?per_page=100&page=1': list });
    const mr = (extra = {}) => ({ '/projects/42/merge_requests/7': { iid: 7, title: 'Add a', author: { username: 'jane' }, labels: [], ...extra } });

    it('requires nothing outside a merge request', async () => {
      const io = setup({ env: GITLAB });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 0);
      assert.equal(io.requests.length, 0);
    });

    it('fails without a token, with a clear error', async () => {
      const io = setup({ env: { ...GITLAB, GITLAB_TOKEN: '', CI_MERGE_REQUEST_IID: '7' } });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 1);
      assert.deepEqual(io.errors, [
        'GITLAB_TOKEN is not set (GITLAB_TOKEN needs a token with the read_api scope: CI_JOB_TOKEN cannot read merge requests): cannot read merge requests from the GitLab API.',
      ]);
      assert.equal(io.requests.length, 0);
    });

    it('fails when matching files change without a fragment', async () => {
      const page1 = Array.from({ length: 100 }, (_, index) => ({ new_path: `docs/${index}.md`, deleted_file: false }));
      const io = setup({
        env: { ...GITLAB, CI_MERGE_REQUEST_IID: '7' },
        routes: {
          ...mr(),
          '/projects/42/merge_requests/7/diffs?per_page=100&page=1': page1,
          '/projects/42/merge_requests/7/diffs?per_page=100&page=2': [
            { new_path: 'packages/a.ts', deleted_file: false },
            { new_path: '.changelog/old.md', deleted_file: true },
          ],
        },
      });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 1);
      assert.match(io.errors[0], /^\.changelog:1: This merge request changes 1 file\(s\) matching packages\/\*\* \(e\.g\. packages\/a\.ts\) but adds no fragment/);
      assert.equal(io.requests.length, 3);
      assert.deepEqual(io.requests[0].init.headers, { 'PRIVATE-TOKEN': 'glpat-secret' });
    });

    it('passes when a fragment is added', async () => {
      const io = setup({
        env: { ...GITLAB, CI_MERGE_REQUEST_IID: '7' },
        routes: { ...mr(), ...diffs([{ new_path: 'packages/a.ts' }, { new_path: '.changelog/a.md', deleted_file: false }]) },
      });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 0);
    });

    it('skips the requirement with the skip label or for skip-authors', async () => {
      let io = setup({ env: { ...GITLAB, CI_MERGE_REQUEST_IID: '7' }, routes: mr({ labels: ['no-changelog'] }) });
      assert.equal(await main(['check', '--require-paths', 'packages/**'], io), 0);
      assert.equal(io.logs[1], 'Label "no-changelog" is set: no fragment required.');

      io = setup({ env: { ...GITLAB, CI_MERGE_REQUEST_IID: '7' }, routes: mr({ author: { username: 'renovate-bot' } }) });
      assert.equal(await main(['check', '--require-paths', 'packages/**', '--skip-authors', 'renovate-bot'], io), 0);
      assert.equal(io.logs[1], 'Author "renovate-bot" is in skip-authors: no fragment required.');
      assert.equal(io.requests.length, 1);
    });

    it('uses GitHub when --platform says so', async () => {
      const io = setup({ env: { ...GITLAB, CI_MERGE_REQUEST_IID: '7' } });
      assert.equal(await main(['check', '--require-paths', 'packages/**', '--platform', 'github'], io), 0);
      assert.equal(io.requests.length, 0);
    });
  });
});

describe('release', () => {
  it('requires a version', async () => {
    const io = setup();
    assert.equal(await main(['release'], io), 1);
    assert.equal(io.errors[0], 'Missing --version.');
  });

  it('folds fragments into CHANGELOG.md, deletes them and sets outputs', async () => {
    const io = setup({
      fragments: { 'b.md': '### Fixed\n- Fix b\n', 'a.md': '### Added\n- Add a\n', 'empty.md': '\n' },
      env: { GITHUB_OUTPUT: '' },
      commits: { '.changelog/a.md': 'aaa 200\n', '.changelog/b.md': 'bbb 100\n' },
      routes: {
        '/repos/acme/repo/commits/aaa/pulls': [{ number: 3, merged_at: null }, { number: 4, merged_at: '2026-10-01' }],
        '/repos/acme/repo/commits/bbb/pulls': [{ number: 2, merged_at: '2026-09-01' }],
      },
    });
    io.env.GITHUB_OUTPUT = join(io.cwd, 'output.txt');

    assert.equal(await main(['release', '--version', '0.2.0', '--date', '2026-10-12'], io), 0);
    const changelog = readFileSync(join(io.cwd, 'CHANGELOG.md'), 'utf8');
    assert.equal(
      changelog,
      '# Changelog\n\n## 0.2.0 - 2026-10-12\n\n### Added\n\n- Add a [[#4]]\n\n### Fixed\n\n- Fix b [[#2]]\n\n[#2]: https://github.com/acme/repo/pull/2\n[#4]: https://github.com/acme/repo/pull/4\n\n## 0.1.0 - 2026-01-01\n\n- Old\n',
    );
    assert.equal(existsSync(join(io.cwd, '.changelog/a.md')), false);
    assert.equal(existsSync(join(io.cwd, '.changelog/b.md')), false);
    assert.equal(existsSync(join(io.cwd, '.changelog/empty.md')), true);
    assert.equal(existsSync(join(io.cwd, '.changelog/.gitkeep')), true);

    const output = readFileSync(io.env.GITHUB_OUTPUT, 'utf8');
    assert.match(output, /^changed<<EOF_[\w-]+\ntrue\nEOF_[\w-]+\n/);
    assert.match(output, /body<<(EOF_[\w-]+)\n### Added\n\n- Add a \[\[#4\]\][\s\S]*\/pull\/4\n\1\n$/);
  });

  it('keeps fragments without a pull request, after the others', async () => {
    const io = setup({
      fragments: { 'a.md': '### Added\n- Uncommitted\n', 'b.md': '### Added\n- No PR\n', 'c.md': '### Added\n- API down\n' },
      commits: { '.changelog/b.md': 'bbb 100', '.changelog/c.md': 'ccc 50' },
      routes: { '/repos/acme/repo/commits/bbb/pulls': [] },
    });
    assert.equal(await main(['release', '--version', '0.2.0', '--date', '2026-10-12'], io), 0);
    assert.match(readFileSync(join(io.cwd, 'CHANGELOG.md'), 'utf8'), /### Added\n\n- API down\n- No PR\n- Uncommitted\n\n## 0\.1\.0/);
    assert.match(io.errors[0], /Cannot find the pull request of \.changelog\/c\.md \(ccc\): GitHub API .* answered 404/);
  });

  it('works outside GitHub without pull request lookups', async () => {
    const io = setup({ fragments: { 'a.md': '### Added\n- A\n' }, commits: { '.changelog/a.md': 'aaa 1', HEAD: '0.1.0' } });
    delete io.env.GITHUB_REPOSITORY;
    assert.equal(await main(['release', '--version', '0.2.0'], io), 0);
    assert.equal(io.requests.length, 0);
    assert.deepEqual(io.errors, ['Warning: GITHUB_REPOSITORY is not set: no pull request references and no entries from skip-authors.']);
    assert.match(readFileSync(join(io.cwd, 'CHANGELOG.md'), 'utf8'), /## 0\.2\.0 - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- A\n/);
  });

  it('changes nothing when there are no fragments', async () => {
    const io = setup();
    io.env.GITHUB_OUTPUT = join(io.cwd, 'output.txt');
    assert.equal(await main(['release', '--version', '0.2.0'], io), 0);
    assert.equal(io.logs.at(-1), 'No fragment in .changelog/ and no pull request from skip-authors: CHANGELOG.md is unchanged.');
    assert.match(readFileSync(io.env.GITHUB_OUTPUT, 'utf8'), /^changed<<.*\nfalse\n/);
  });

  it('changes nothing when a fragment is invalid', async () => {
    const io = setup({ fragments: { 'a.md': '### Added\n- A\n', 'b.md': '## Bad\n' } });
    assert.equal(await main(['release', '--version', '0.2.0'], io), 1);
    assert.equal(io.errors.at(-1), 'Invalid fragments: CHANGELOG.md and .changelog/ are unchanged.');
    assert.equal(existsSync(join(io.cwd, '.changelog/a.md')), true);
    assert.doesNotMatch(readFileSync(join(io.cwd, 'CHANGELOG.md'), 'utf8'), /0\.2\.0/);
  });

  it('fails without CHANGELOG.md', async () => {
    const io = setup({ fragments: { 'a.md': '### Added\n- A\n' }, changelog: null });
    assert.equal(await main(['release', '--version', '0.2.0'], io), 1);
    assert.match(io.errors[0], /CHANGELOG\.md not found/);
    assert.equal(existsSync(join(io.cwd, '.changelog/a.md')), true);
  });

  describe('with pull requests from skip-authors', () => {
    const pull = (number, login, extra = {}) => [{ number, title: `chore(deps): update ${number}`, merged_at: '2026-10-01', user: { login }, labels: [], ...extra }];

    it('adds the merged pull requests since the previous tag under Dependencies', async () => {
      const io = setup({
        fragments: { 'a.md': '### Added\n- Add a\n' },
        commits: {
          '.changelog/a.md': 's5 500',
          HEAD: '1.0.0\n',
          '1.0.0..HEAD': 's7\ns6\ns5\ns4\ns3\ns2\ns1\ns0\n',
        },
        routes: {
          '/repos/acme/repo/commits/s0/pulls': pull(10, 'renovate[bot]'),
          '/repos/acme/repo/commits/s1/pulls': pull(10, 'renovate[bot]'),
          '/repos/acme/repo/commits/s2/pulls': pull(11, 'renovate[bot]', { labels: [{ name: 'no-changelog' }] }),
          '/repos/acme/repo/commits/s3/pulls': pull(12, 'someone'),
          '/repos/acme/repo/commits/s4/pulls': [{ ...pull(13, 'renovate[bot]')[0], merged_at: null }],
          '/repos/acme/repo/commits/s5/pulls': pull(14, 'renovate[bot]'),
          '/repos/acme/repo/commits/s6/pulls': [],
          '/repos/acme/repo/commits/s7/pulls': pull(15, 'renovate[bot]'),
        },
      });
      assert.equal(await main(['release', '--version', '1.1.0', '--date', '2026-10-12'], io), 0);
      assert.match(
        readFileSync(join(io.cwd, 'CHANGELOG.md'), 'utf8'),
        /## 1\.1\.0 - 2026-10-12\n\n### Added\n\n- Add a \[\[#14\]\]\n\n### Dependencies\n\n- Update 10 \[\[#10\]\]\n- Update 15 \[\[#15\]\]\n\n\[#10\]: https:\/\/github\.com\/acme\/repo\/pull\/10\n\[#14\]: .*\/pull\/14\n\[#15\]: .*\/pull\/15\n\n## 0\.1\.0/,
      );
      assert.deepEqual(io.errors, []);
    });

    it('sets changed with pull requests alone and reports API errors', async () => {
      const io = setup({
        commits: { HEAD: '1.0.0', '1.0.0..HEAD': 'bad\ngood\n' },
        routes: { '/repos/acme/repo/commits/good/pulls': pull(3, 'bot-b', { labels: [{ name: 'internal' }] }) },
      });
      io.env.GITHUB_OUTPUT = join(io.cwd, 'output.txt');
      assert.equal(await main(['release', '--version', '1.1.0', '--skip-authors', 'bot-a, bot-b', '--skip-label', 'skip'], io), 0);
      assert.match(readFileSync(join(io.cwd, 'CHANGELOG.md'), 'utf8'), /### Dependencies\n\n- Update 3 \[\[#3\]\]\n/);
      assert.match(readFileSync(io.env.GITHUB_OUTPUT, 'utf8'), /^changed<<.*\ntrue\n/);
      assert.match(io.errors[0], /^Cannot find the pull request of bad: GitHub API .* answered 404/);
    });

    it('adds nothing without a previous tag', async () => {
      const io = setup();
      io.git = (args) => {
        if (args[0] === 'describe') throw new Error('fatal: No names found');
        return '';
      };
      assert.equal(await main(['release', '--version', '1.0.0'], io), 0);
      assert.equal(io.logs[0], 'No previous tag: no pull request from skip-authors to add.');
      assert.equal(io.requests.length, 0);
    });

    it('adds nothing when skip-authors is empty', async () => {
      const io = setup({ commits: { HEAD: '1.0.0', '1.0.0..HEAD': 's1\n' } });
      assert.equal(await main(['release', '--version', '1.1.0', '--skip-authors', ''], io), 0);
      assert.equal(io.requests.length, 0);
    });
  });

  describe('on GitLab', () => {
    const mrs = (iid, username, extra = {}) => [
      { iid, title: `chore(deps): update ${iid}`, state: 'merged', author: { username }, labels: [], ...extra },
    ];

    it('writes merge request references, French sections and skip-authors entries', async () => {
      const io = setup({
        env: GITLAB,
        fragments: { 'a.md': '### Corrigé\n- Corrige a\n', 'b.md': '### Ajouté\n- Ajoute b\n' },
        commits: {
          '.changelog/a.md': 'sa 100',
          '.changelog/b.md': 'sb 200',
          HEAD: 'v2026.9.0\n',
          'v2026.9.0..HEAD': 's4\ns3\ns2\ns1\nsa\n',
        },
        routes: {
          '/projects/42/repository/commits/sa/merge_requests': [{ iid: 8, state: 'opened' }, ...mrs(9, 'jane')],
          '/projects/42/repository/commits/s1/merge_requests': mrs(10, 'renovate-bot'),
          '/projects/42/repository/commits/s2/merge_requests': mrs(11, 'renovate-bot', { labels: ['no-changelog'] }),
          '/projects/42/repository/commits/s3/merge_requests': [{ iid: 12, title: 'No author', state: 'merged' }],
          '/projects/42/repository/commits/s4/merge_requests': [],
        },
      });
      const argv = ['release', '--version', 'v2026.10.0', '--date', '2026-10-12', '--locale', 'fr', '--skip-authors', 'renovate-bot'];
      assert.equal(await main(argv, io), 0);
      assert.match(
        readFileSync(join(io.cwd, 'CHANGELOG.md'), 'utf8'),
        new RegExp(
          [
            '## v2026\\.10\\.0 - 2026-10-12',
            '',
            '### Ajouté',
            '',
            '- Ajoute b',
            '',
            '### Corrigé',
            '',
            '- Corrige a \\[\\[!9\\]\\]',
            '',
            '### Dépendances',
            '',
            '- Update 10 \\[\\[!10\\]\\]',
            '',
            '\\[!9\\]: https://gitlab\\.test/acme/repo/-/merge_requests/9',
            '\\[!10\\]: https://gitlab\\.test/acme/repo/-/merge_requests/10',
            '',
            '## 0\\.1\\.0',
          ].join('\n'),
        ),
      );
      assert.equal(io.errors.length, 1);
      assert.match(io.errors[0], /^Cannot find the merge request of \.changelog\/b\.md \(sb\): GitLab API \/projects\/42\/repository\/commits\/sb\/merge_requests answered 404\.$/);
    });

    it('adds no reference and no skip-authors entry without a token, with a warning', async () => {
      const io = setup({
        env: { ...GITLAB, GITLAB_TOKEN: undefined },
        fragments: { 'a.md': '### Added\n- Add a\n' },
        commits: { '.changelog/a.md': 'sa 100', HEAD: '1.0.0', '1.0.0..HEAD': 'sa\n' },
      });
      assert.equal(await main(['release', '--version', '1.1.0', '--date', '2026-10-12'], io), 0);
      assert.equal(io.requests.length, 0);
      assert.deepEqual(io.errors, [
        'Warning: GITLAB_TOKEN is not set (GITLAB_TOKEN needs a token with the read_api scope: CI_JOB_TOKEN cannot read merge requests): no merge request references and no entries from skip-authors.',
      ]);
      assert.match(readFileSync(join(io.cwd, 'CHANGELOG.md'), 'utf8'), /## 1\.1\.0 - 2026-10-12\n\n### Added\n\n- Add a\n\n## 0\.1\.0/);
    });

    it('warns with a GitHub annotation when GitLab variables are missing in GitHub Actions', async () => {
      const io = setup({ env: { GITHUB_ACTIONS: 'true' }, fragments: { 'a.md': '### Added\n- A\n' } });
      assert.equal(await main(['release', '--version', '1.1.0', '--platform', 'gitlab'], io), 0);
      assert.deepEqual(io.errors, [
        '::warning::CI_API_V4_URL, CI_PROJECT_ID, CI_PROJECT_URL, GITLAB_TOKEN are not set (GITLAB_TOKEN needs a token with the read_api scope: CI_JOB_TOKEN cannot read merge requests): no merge request references and no entries from skip-authors.',
      ]);
    });

    it('names only the missing project variables when the token is set', async () => {
      const io = setup({ env: { GITLAB_CI: 'true', GITLAB_TOKEN: 'x', CI_API_V4_URL: 'https://gitlab.test/api/v4' } });
      assert.equal(await main(['release', '--version', '1.1.0'], io), 0);
      assert.equal(io.errors[0], 'Warning: CI_PROJECT_ID, CI_PROJECT_URL are not set: no merge request references and no entries from skip-authors.');
      const one = setup({ env: { ...GITLAB, CI_PROJECT_URL: '' } });
      assert.equal(await main(['release', '--version', '1.1.0'], one), 0);
      assert.equal(one.errors[0], 'Warning: CI_PROJECT_URL is not set: no merge request references and no entries from skip-authors.');
    });

    it('encodes a project path given as CI_PROJECT_ID', async () => {
      const io = setup({ env: { ...GITLAB, CI_PROJECT_ID: 'acme/repo' }, commits: { HEAD: '1.0.0', '1.0.0..HEAD': 's1\n' } });
      assert.equal(await main(['release', '--version', '1.1.0'], io), 0);
      assert.equal(io.requests[0].url, 'https://gitlab.test/api/v4/projects/acme%2Frepo/repository/commits/s1/merge_requests');
    });
  });
});
