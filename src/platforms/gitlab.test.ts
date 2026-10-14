import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Git } from '../git.js';
import { routeFetch, tableGit } from '../test-utils.js';
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

function platform(
  env: Record<string, string>,
  fetchImpl = routeFetch({}),
  argv: string[] = [],
  git: Git = tableGit({}),
) {
  return new GitLabPlatform(resolveConfig(['check', ...argv], env).gitlab, fetchImpl, git);
}

/**
 * A git that answers `merge-base --is-ancestor` from a commit graph (each
 * commit and its parents). Like git, it fails for an unknown object.
 */
function graphGit(parents: Record<string, string[]>): Git {
  const resolve = (revision: string): string => {
    const [commit, parent] = revision.split('^');
    const sha = parent === undefined ? commit : parents[commit]?.[Number(parent) - 1];
    if (sha === undefined || !(sha in parents)) throw new Error(`Not a valid commit: ${revision}`);
    return sha;
  };
  return vi.fn<Git>(async (args) => {
    const [command, flag, ancestor, commit] = args;
    if (`${command} ${flag}` !== 'merge-base --is-ancestor') {
      throw new Error(`Unexpected git ${args.join(' ')}`);
    }
    const target = resolve(ancestor);
    const queue = [resolve(commit)];
    for (const sha of queue) {
      if (sha === target) return '';
      queue.push(...parents[sha]);
    }
    throw new Error('Not an ancestor');
  });
}

/**
 * A stack merged from the top: !13 into the branch of !12 (after a retarget),
 * !12 into the branch of !11, !11 into the branch of !10, then !10 into main.
 * The fragment commit `cN` is on the branch of !N, `mN` is the merge commit of !N.
 */
const STACK = {
  base: [],
  c10: ['base'],
  c11: ['c10'],
  c12: ['c11'],
  c13: ['c12'],
  m13: ['c12', 'c13'],
  m12: ['c11', 'm13'],
  m11: ['c10', 'm12'],
  main: ['base'],
  m10: ['main', 'm11'],
};

function merged(iid: number, target: string, mergeCommit: string | null = `m${iid}`) {
  return {
    iid,
    title: `MR ${iid}`,
    state: 'merged',
    target_branch: target,
    merge_commit_sha: mergeCommit,
  };
}

const MR10 = merged(10, 'main');
const MR11 = merged(11, 'feature/a');
const MR12 = merged(12, 'feature/b');
const MR13 = merged(13, 'feature/c');

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

  it('finds the merged merge request, into the current branch first', async () => {
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
      [`${API}/repository/commits/none/merge_requests`]: [
        { iid: 5, state: 'opened', target_branch: 'main' },
      ],
    });
    const gitlab = platform({ ...CI, CI_COMMIT_BRANCH: 'main' }, fetchImpl);
    expect(await gitlab.findMergedChange('abc')).toEqual({
      number: 3,
      title: 'Update x',
      author: 'foxy',
      labels: ['deps'],
    });
    const bare = { number: 4, title: 'Bare', author: undefined, labels: [] };
    expect(await gitlab.findMergedChange('def')).toEqual(bare);
    expect(await platform(CI, fetchImpl).findMergedChange('def')).toEqual(bare);
    expect(await gitlab.findMergedChange('none')).toBeNull();
  });

  it('finds the merge request that brought a commit of a stack merged from the top', async () => {
    // GitLab links each commit to its merge request and to the ones below it, in any order.
    const fetchImpl = routeFetch({
      [`${API}/repository/commits/c10/merge_requests`]: [MR13, MR10],
      [`${API}/repository/commits/c11/merge_requests`]: [MR11, MR13, MR10],
      [`${API}/repository/commits/c12/merge_requests`]: [MR12, MR11, MR13, MR10],
      [`${API}/repository/commits/c13/merge_requests`]: [MR12, MR11, MR13, MR10],
    });
    const git = graphGit(STACK);
    const gitlab = platform({ ...CI, CI_COMMIT_BRANCH: 'main' }, fetchImpl, [], git);
    const numbers: (number | undefined)[] = [];
    for (const sha of ['c10', 'c11', 'c12', 'c13']) {
      numbers.push((await gitlab.findMergedChange(sha))?.number);
    }
    expect(numbers).toEqual([10, 11, 12, 13]);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://gitlab.example.com/api/v4/projects/42/repository/commits/c10/merge_requests',
    );
    expect(git).toHaveBeenCalledWith(['merge-base', '--is-ancestor', 'c13', 'm13^2']);
    expect(git).toHaveBeenCalledWith(['merge-base', '--is-ancestor', 'c13', 'm13^1']);
    expect(git).toHaveBeenCalledWith(['merge-base', '--is-ancestor', 'm13', 'm12']);
  });

  it('keeps the target branch rule when git cannot tell', async () => {
    const fetchImpl = routeFetch({
      // Squash merges (one parent) and a fast-forward merge (no merge commit).
      [`${API}/repository/commits/c20/merge_requests`]: [
        merged(21, 'next', 's21'),
        merged(22, 'main', null),
        merged(23, 'main', 's23'),
      ],
      // A commit that the clone does not have.
      [`${API}/repository/commits/gone/merge_requests`]: [MR13, MR10],
      // One commit merged into two branches: neither merge comes first.
      [`${API}/repository/commits/c30/merge_requests`]: [merged(31, 'release'), merged(30, 'main')],
    });
    const git = graphGit({
      ...STACK,
      c20: ['base'],
      s21: ['base'],
      s23: ['s21'],
      c30: ['base'],
      m30: ['main', 'c30'],
      release: ['base'],
      m31: ['release', 'c30'],
    });
    const gitlab = platform({ ...CI, CI_COMMIT_BRANCH: 'main' }, fetchImpl, [], git);
    expect((await gitlab.findMergedChange('c20'))?.number).toBe(22);
    expect((await gitlab.findMergedChange('gone'))?.number).toBe(10);
    expect((await gitlab.findMergedChange('c30'))?.number).toBe(30);
    expect((await platform(CI, fetchImpl, [], git).findMergedChange('c30'))?.number).toBe(31);
  });
});
