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

  it('finds the merged pull request into the current branch', async () => {
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
    expect(await github.findMergedChange('none')).toBeNull();

    const anyBranch = platform({ GITHUB_REPOSITORY: 'acme/repo' }, fetchImpl);
    expect(await anyBranch.findMergedChange('def')).toEqual({
      number: 4,
      title: 'Bare',
      author: undefined,
      labels: [],
    });
  });
});
