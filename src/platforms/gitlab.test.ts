import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import { routeFetch } from '../test-utils.js';
import { GitLabPlatform } from './gitlab.js';

const CI = {
  GITLAB_CI: 'true',
  CI_SERVER_URL: 'https://gitlab.example.com',
  CI_PROJECT_ID: '42',
  CI_PROJECT_URL: 'https://gitlab.example.com/group/project',
  CI_JOB_TOKEN: 'job-token',
};

const MR_PIPELINE = {
  ...CI,
  CI_MERGE_REQUEST_IID: '7',
  CI_MERGE_REQUEST_LABELS: 'bug',
  CI_MERGE_REQUEST_DIFF_BASE_SHA: 'base',
};

const API = '/api/v4/projects/42';

function platform(env: Record<string, string>, fetchImpl = routeFetch({}), argv: string[] = []) {
  return new GitLabPlatform(resolveConfig(['check', ...argv], env).gitlab, fetchImpl);
}

describe('GitLabPlatform', () => {
  it('writes !N references to the project', () => {
    const gitlab = platform(CI);
    expect(gitlab.unavailable).toBeNull();
    expect(gitlab.noun).toBe('merge request');
    expect(gitlab.references.prefix).toBe('!');
    expect(gitlab.references.url(3)).toBe(
      'https://gitlab.example.com/group/project/-/merge_requests/3',
    );
  });

  it('names what is missing to use the API', async () => {
    const none = platform({ CHANGELOG_PLATFORM: 'gitlab' });
    expect(none.unavailable).toBe(
      'Missing CI_SERVER_URL (or --gitlab-url), CI_PROJECT_ID (or --project), a token (GITLAB_TOKEN, GLAB_CLI_TOKEN or CI_JOB_TOKEN)',
    );
    await expect(none.findMergedChange('abc')).rejects.toThrow(/cannot read merge requests\.$/);

    const numeric = platform({ CHANGELOG_PLATFORM: 'gitlab', GITLAB_TOKEN: 't' }, routeFetch({}), [
      '--gitlab-url',
      'https://g.test',
      '--project',
      '42',
    ]);
    expect(numeric.unavailable).toBe(
      'Missing CI_PROJECT_URL: pass --project as a path (group/project)',
    );
  });

  it('reads a merge request pipeline from its variables, and the author once from the API', async () => {
    const fetchImpl = routeFetch({
      [`${API}/merge_requests/7`]: { iid: 7, author: { username: 'foxy' } },
    });
    const change = await platform(MR_PIPELINE, fetchImpl).currentChange();
    expect(change).toMatchObject({ number: 7, labels: ['bug'], baseSha: 'base' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await change?.author()).toBe('foxy');
    expect(await change?.author()).toBe('foxy');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads the merge request of --mr from the API', async () => {
    const fetchImpl = routeFetch({
      [`${API}/merge_requests/9`]: {
        iid: 9,
        labels: ['no-changelog'],
        author: { username: 'dev' },
        diff_refs: { base_sha: 'b9' },
      },
    });
    const change = await platform(MR_PIPELINE, fetchImpl, ['--mr', '9']).currentChange();
    expect(change).toMatchObject({ number: 9, labels: ['no-changelog'], baseSha: 'b9' });
    expect(await change?.author()).toBe('dev');
  });

  it('finds the open merge request of a branch pipeline', async () => {
    const fetchImpl = routeFetch({
      [`${API}/merge_requests?source_branch=feature&state=opened`]: [{ iid: 11 }],
      [`${API}/merge_requests/11`]: { iid: 11, diff_refs: { base_sha: 'b11' } },
    });
    const change = await platform(
      { ...CI, CI_COMMIT_BRANCH: 'feature' },
      fetchImpl,
    ).currentChange();
    expect(change).toMatchObject({ number: 11, labels: [], baseSha: 'b11' });
    expect(await change?.author()).toBeUndefined();
  });

  it('has no current change without an open merge request or a branch', async () => {
    const fetchImpl = routeFetch({
      [`${API}/merge_requests?source_branch=main&state=opened`]: [],
    });
    expect(
      await platform({ ...CI, CI_COMMIT_BRANCH: 'main' }, fetchImpl).currentChange(),
    ).toBeNull();
    expect(await platform(CI).currentChange()).toBeNull();
  });

  it('needs the diff base of the merge request', async () => {
    const fetchImpl = routeFetch({ [`${API}/merge_requests/9`]: { iid: 9, diff_refs: null } });
    await expect(platform(CI, fetchImpl, ['--mr', '9']).currentChange()).rejects.toThrow(
      'Merge request !9 has no diff base yet.',
    );
  });

  it('finds the merged merge request into the current branch', async () => {
    const fetchImpl = routeFetch({
      [`${API}/repository/commits/abc/merge_requests`]: [
        { iid: 1, state: 'opened', target_branch: 'main' },
        { iid: 2, state: 'merged', target_branch: 'next' },
        {
          iid: 3,
          title: 'Update x',
          state: 'merged',
          target_branch: 'main',
          author: { username: 'foxy' },
          labels: ['deps'],
        },
      ],
      [`${API}/repository/commits/def/merge_requests`]: [
        { iid: 4, title: 'Bare', state: 'merged', target_branch: 'next' },
      ],
    });
    const gitlab = platform({ ...CI, CI_COMMIT_BRANCH: 'main' }, fetchImpl);
    expect(await gitlab.findMergedChange('abc')).toEqual({
      number: 3,
      title: 'Update x',
      author: 'foxy',
      labels: ['deps'],
    });
    expect(await gitlab.findMergedChange('def')).toBeNull();
    expect(await platform(CI, fetchImpl).findMergedChange('def')).toEqual({
      number: 4,
      title: 'Bare',
      author: undefined,
      labels: [],
    });
  });
});
