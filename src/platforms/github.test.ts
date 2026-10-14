import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import { routeFetch } from '../test-utils.js';
import { GitHubPlatform } from './github.js';

function platform(env: Record<string, string>, fetchImpl = routeFetch({}), event?: string) {
  const config = resolveConfig(
    ['check'],
    { GITHUB_EVENT_PATH: '/event.json', ...env },
    () => event,
  );
  return new GitHubPlatform(config.github, fetchImpl);
}

describe('GitHubPlatform', () => {
  it('writes #N references to the repository', () => {
    const github = platform({ GITHUB_REPOSITORY: 'acme/repo' });
    expect(github.unavailable).toBeNull();
    expect(github.references.prefix).toBe('#');
    expect(github.references.url(4)).toBe('https://github.com/acme/repo/pull/4');
    expect(github.noun).toBe('pull request');
  });

  it('is unavailable without GITHUB_REPOSITORY', async () => {
    const github = platform({});
    expect(github.unavailable).toBe('GITHUB_REPOSITORY is not set');
    await expect(github.findMergedChange('abc')).rejects.toThrow(
      'GITHUB_REPOSITORY is not set: cannot read pull requests.',
    );
  });

  it('takes the current change from the event payload', async () => {
    const github = platform(
      {},
      routeFetch({}),
      JSON.stringify({
        pull_request: {
          number: 5,
          user: { login: 'octocat' },
          labels: [{ name: 'no-changelog' }],
          base: { sha: 'base' },
        },
      }),
    );
    const change = await github.currentChange();
    expect(change).toMatchObject({ number: 5, labels: ['no-changelog'], baseSha: 'base' });
    expect(await change?.author()).toBe('octocat');
  });

  it('has no current change outside a pull request', async () => {
    expect(await platform({}, routeFetch({}), '{}').currentChange()).toBeNull();
  });

  it('needs the base SHA of the pull request', async () => {
    await expect(
      platform({}, routeFetch({}), '{"pull_request":{"number":5}}').currentChange(),
    ).rejects.toThrow('The event payload of pull request #5 has no base SHA.');
  });

  it('finds the merged pull request, into the current branch first', async () => {
    const fetchImpl = routeFetch({
      '/repos/acme/repo/commits/abc/pulls': [
        { number: 1, title: 'Open', merged_at: null, base: { ref: 'main' } },
        { number: 2, title: 'Other branch', merged_at: '2026-01-01', base: { ref: 'next' } },
        {
          number: 3,
          title: 'Merged',
          merged_at: '2026-01-02',
          base: { ref: 'main' },
          user: { login: 'renovate[bot]' },
          labels: [{ name: 'deps' }, {}],
        },
      ],
      '/repos/acme/repo/commits/def/pulls': [{ number: 4, title: 'Bare', merged_at: '2026-01-03' }],
      '/repos/acme/repo/commits/stacked/pulls': [
        { number: 5, title: 'Open', merged_at: null, base: { ref: 'main' } },
        { number: 6, title: 'Stacked', merged_at: '2026-01-04', base: { ref: 'feature/a' } },
      ],
      '/repos/acme/repo/commits/none/pulls': [],
    });
    const github = platform(
      { GITHUB_REPOSITORY: 'acme/repo', GITHUB_REF: 'refs/heads/main' },
      fetchImpl,
    );
    expect(await github.findMergedChange('abc')).toEqual({
      number: 3,
      title: 'Merged',
      author: 'renovate[bot]',
      labels: ['deps'],
    });
    expect(await github.findMergedChange('stacked')).toEqual({
      number: 6,
      title: 'Stacked',
      author: undefined,
      labels: [],
    });
    expect(await github.findMergedChange('none')).toBeNull();

    const anyBranch = platform({ GITHUB_REPOSITORY: 'acme/repo' }, fetchImpl);
    expect(await anyBranch.findMergedChange('def')).toEqual({
      number: 4,
      title: 'Bare',
      author: undefined,
      labels: [],
    });
  });

  it('finds the stacked pull request that added a fragment after gh stack merge', async () => {
    // Every commit of the stack links to the bottom pull request (#85).
    const bottom = {
      number: 85,
      title: 'Bottom',
      merged_at: '2026-01-01',
      base: { ref: 'main' },
      head: { ref: 'feature/a' },
    };
    const fetchImpl = routeFetch({
      '/repos/acme/repo/commits/sha/pulls': [bottom],
      '/repos/acme/repo/pulls/85/files': [
        { filename: 'src/a.ts' },
        { filename: '.changelog/a.md' },
      ],
      '/repos/acme/repo/pulls?state=closed&base=feature%2Fa&': [
        { number: 84, title: 'Closed', merged_at: null, head: { ref: 'feature/x' } },
        { number: 86, title: 'Middle', merged_at: '2026-01-01', head: { ref: 'feature/b' } },
      ],
      '/repos/acme/repo/pulls/86/files': [{ filename: '.changelog/b.md' }],
      '/repos/acme/repo/pulls?state=closed&base=feature%2Fb&': [
        bottom,
        { number: 87, title: 'Bare', merged_at: '2026-01-01' },
        {
          number: 88,
          title: 'Top',
          merged_at: '2026-01-01',
          head: { ref: 'feature/c' },
          user: { login: 'octocat' },
          labels: [{ name: 'feature' }],
        },
      ],
      '/repos/acme/repo/pulls/87/files': [],
      '/repos/acme/repo/pulls/88/files': [{ filename: '.changelog/c.md' }],
      '/repos/acme/repo/pulls?state=closed&base=feature%2Fc&': [],
    });
    const github = platform(
      { GITHUB_REPOSITORY: 'acme/repo', GITHUB_REF: 'refs/heads/main' },
      fetchImpl,
    );

    expect(await github.findMergedChange('sha', '.changelog/a.md')).toMatchObject({ number: 85 });
    expect(await github.findMergedChange('sha', '.changelog/b.md')).toMatchObject({ number: 86 });
    expect(await github.findMergedChange('sha', '.changelog/c.md')).toEqual({
      number: 88,
      title: 'Top',
      author: 'octocat',
      labels: ['feature'],
    });
    // No pull request of the stack lists the file: the one of the commit.
    expect(await github.findMergedChange('sha', '.changelog/gone.md')).toMatchObject({
      number: 85,
    });

    // Each list is read once.
    const paths = fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths.filter((path) => path === '/repos/acme/repo/pulls/85/files')).toHaveLength(1);
    expect(paths.filter((path) => path === '/repos/acme/repo/pulls')).toHaveLength(3);
  });
});
