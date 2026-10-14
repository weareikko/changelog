import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from './errors.js';
import { GitHubClient } from './github.js';

function client(fetchImpl: typeof fetch, token = 'secret-token') {
  return new GitHubClient({
    apiUrl: 'https://api.github.com/',
    repository: 'acme/repo',
    token,
    fetch: fetchImpl,
  });
}

async function rejection(promise: Promise<unknown>): Promise<GitHubApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof GitHubApiError)) throw new Error('Expected a GitHubApiError');
  return error;
}

describe('GitHubClient', () => {
  it('lists the pull requests of a commit with a bearer token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([{ number: 1 }]));
    expect(await client(fetchImpl).listCommitPulls('abc')).toEqual([{ number: 1 }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/repo/commits/abc/pulls');
    expect(init?.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: 'Bearer secret-token',
    });
  });

  it('lists the closed pull requests of a base branch, every page', async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      Response.json(String(input).endsWith('page=1') ? full : [{ number: 101 }]),
    );
    expect(await client(fetchImpl).listClosedPulls('feature/a b')).toHaveLength(101);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/acme/repo/pulls?state=closed&base=feature%2Fa%20b&per_page=100&page=1',
      'https://api.github.com/repos/acme/repo/pulls?state=closed&base=feature%2Fa%20b&per_page=100&page=2',
    ]);
    expect(fetchImpl.mock.calls[0][1]?.headers).toHaveProperty(
      'Authorization',
      'Bearer secret-token',
    );
  });

  it('lists the file paths of a pull request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json([{ filename: '.changelog/a.md' }, { filename: 'src/a.ts' }]),
    );
    expect(await client(fetchImpl).listPullFiles(6)).toEqual(['.changelog/a.md', 'src/a.ts']);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/repo/pulls/6/files?per_page=100&page=1',
    );
  });

  it('explains a refused token on a list endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    const error = await rejection(client(fetchImpl).listPullFiles(6));
    expect(error.message).toBe(
      'GitHub API GET /repos/acme/repo/pulls/6/files?per_page=100&page=1 answered 404.',
    );
    expect(error.hint).toContain('pull-requests: read');
  });

  it('sends no Authorization header without a token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([]));
    await client(fetchImpl, '').listCommitPulls('abc');
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
  });

  it('explains a refused token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }));
    const error = await rejection(client(fetchImpl).listCommitPulls('abc'));
    expect(error.message).toBe(
      'GitHub API GET /repos/acme/repo/commits/abc/pulls answered 403: denied',
    );
    expect(error.hint).toContain('pull-requests: read');
  });

  it('gives a server error hint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));
    const error = await rejection(client(fetchImpl).listCommitPulls('abc'));
    expect(error.message).toMatch(/answered 500\.$/);
    expect(error.hint).toBe('GitHub could not answer. Retry the job.');
  });

  it('wraps a network error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await rejection(client(fetchImpl).listCommitPulls('abc'));
    expect(error.message).toBe('Cannot reach the GitHub API at https://api.github.com/.');
  });

  it('uses the global fetch by default', () => {
    expect(() => client(undefined as unknown as typeof fetch)).not.toThrow();
  });
});
