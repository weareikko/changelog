import { describe, expect, it, vi } from 'vitest';
import { GitLabApiError } from './errors.js';
import { gitlabAccessHint, GitLabClient } from './gitlab.js';

function client(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof GitLabClient>[0]> = {},
) {
  return new GitLabClient({
    url: 'https://gitlab.example.com/',
    project: 'group/project',
    token: 'secret-token',
    authHeader: 'JOB-TOKEN',
    tokenSource: 'CI_JOB_TOKEN',
    fetch: fetchImpl,
    ...overrides,
  });
}

async function rejection(promise: Promise<unknown>): Promise<GitLabApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof GitLabApiError)) throw new Error('Expected a GitLabApiError');
  return error;
}

describe('GitLabClient', () => {
  it('reads a merge request with the job token header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ iid: 7 }));
    expect(await client(fetchImpl).getMergeRequest(7)).toEqual({ iid: 7 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests/7',
    );
    expect(init?.headers).toEqual({ Accept: 'application/json', 'JOB-TOKEN': 'secret-token' });
  });

  it('lists the open merge requests of a branch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([]));
    await client(fetchImpl, { authHeader: 'PRIVATE-TOKEN' }).listOpenMergeRequests('feature/a b');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests?source_branch=feature%2Fa+b&state=opened&per_page=100',
    );
    expect(init?.headers).toMatchObject({ 'PRIVATE-TOKEN': 'secret-token' });
  });

  it('lists the merge requests of a commit, without a token header when there is none', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([{ iid: 1 }]));
    expect(
      await client(fetchImpl, { token: '', tokenSource: null }).listCommitMergeRequests('abc'),
    ).toEqual([{ iid: 1 }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://gitlab.example.com/api/v4/projects/group%2Fproject/repository/commits/abc/merge_requests',
    );
    expect(init?.headers).toEqual({ Accept: 'application/json' });
  });

  it('explains a refused job token without printing it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('{"message":"403 Forbidden"}', { status: 403 }),
    );
    const error = await rejection(client(fetchImpl).getMergeRequest(7));
    expect(error.message).toBe(
      'GitLab API GET /projects/group%2Fproject/merge_requests/7 answered 403: {"message":"403 Forbidden"}',
    );
    expect(error.status).toBe(403);
    expect(error.hint).toContain('GitLab 18.4 or later');
    expect(`${error.message}${error.hint}`).not.toContain('secret-token');
  });

  it('gives a server error hint and handles an empty body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 502 }));
    const error = await rejection(client(fetchImpl).listCommitMergeRequests('abc'));
    expect(error.message).toMatch(/answered 502\.$/);
    expect(error.hint).toContain('Retry the job');
  });

  it('wraps a network error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await rejection(client(fetchImpl).getMergeRequest(1));
    expect(error.message).toBe('Cannot reach the GitLab API at https://gitlab.example.com/api/v4.');
    expect(error.hint).toContain('--gitlab-url');
  });

  it('uses the global fetch by default', () => {
    expect(() => client(undefined as unknown as typeof fetch)).not.toThrow();
  });
});

describe('gitlabAccessHint', () => {
  it('names what is missing for each token source', () => {
    expect(gitlabAccessHint(null, 'p')).toMatch(/^No GitLab token/);
    expect(gitlabAccessHint('CI_JOB_TOKEN', 'p')).toContain('set GITLAB_TOKEN');
    expect(gitlabAccessHint('GITLAB_TOKEN', 'group/p')).toMatch(
      /^GITLAB_TOKEN needs the read_api scope and the Reporter role .* "group\/p"/,
    );
    expect(gitlabAccessHint('--gitlab-token', 'p')).toMatch(/^--gitlab-token needs/);
  });
});
