// Pull request lookups on GitHub and merge request lookups on GitLab, behind
// one interface. cli.mjs only talks to a platform; tests inject `env` and
// `fetch` through the Io object.

import { readFileSync } from 'node:fs';

/**
 * @typedef {object} Pull
 * @property {number} number Pull request number (GitHub) or merge request IID (GitLab).
 * @property {string} title
 * @property {string | undefined} author Login (GitHub) or username (GitLab).
 * @property {string[]} labels
 */

/**
 * @typedef {object} Platform
 * @property {'github' | 'gitlab'} name
 * @property {string} noun `pull request` or `merge request`, for messages.
 * @property {{ prefix: string, url: (number: number) => string }} references
 *   `#` and `<repository>/pull/N`, or `!` and `<project>/-/merge_requests/N`.
 * @property {string | null} missing Why the API cannot be used (a missing
 *   variable or token), or null when it can. Every API call then fails.
 * @property {() => Promise<Pull | null>} currentPull The pull request of this
 *   run, or null when the run is not for a pull request.
 * @property {(number: number) => Promise<{ path: string, removed: boolean }[]>} listFiles
 *   The files that a pull request changes.
 * @property {(sha: string) => Promise<Pull | null>} findMergedPull The merged
 *   pull request that added a commit, or null.
 */

/**
 * @typedef {object} PlatformIo
 * @property {Record<string, string | undefined>} env
 * @property {typeof fetch} fetch
 */

/** Platform names, for messages. */
export const PLATFORMS = ['github', 'gitlab'];

/**
 * `gitlab` in GitLab CI, else `github` (in GitHub Actions and outside CI).
 * @param {Record<string, string | undefined>} env
 */
export function detectPlatform(env) {
  return env.GITHUB_ACTIONS !== 'true' && env.GITLAB_CI === 'true' ? 'gitlab' : 'github';
}

/**
 * @param {string} name `github` or `gitlab`.
 * @param {PlatformIo} io
 * @returns {Platform}
 */
export function createPlatform(name, io) {
  if (name === 'github') return github(io);
  if (name === 'gitlab') return gitlab(io);
  throw new Error(`Unknown platform "${name}". Use ${PLATFORMS.join(' or ')}.`);
}

/**
 * Read every page of a list endpoint, 100 items at a time.
 * @param {(path: string) => Promise<unknown[]>} get
 * @param {string} path
 */
async function paginate(get, path) {
  const items = [];
  let page = 0;
  let batch;
  do {
    page += 1;
    batch = await get(`${path}?per_page=100&page=${page}`);
    items.push(...batch);
  } while (batch.length === 100);
  return items;
}

/**
 * @param {PlatformIo} io
 * @returns {Platform}
 */
export function github(io) {
  const { env } = io;
  const repository = env.GITHUB_REPOSITORY;
  const missing = repository ? null : 'GITHUB_REPOSITORY is not set';

  /** @param {string} path Path under the repository, starting with `/`. */
  async function get(path) {
    if (missing) throw new Error(`${missing}: cannot read pull requests from the GitHub API.`);
    const url = `/repos/${repository}${path}`;
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const response = await io.fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}${url}`, { headers });
    if (!response.ok) throw new Error(`GitHub API ${url} answered ${response.status}.`);
    return response.json();
  }

  /** @returns {Pull} */
  const toPull = (pull) => ({
    number: pull.number,
    title: pull.title,
    author: pull.user?.login,
    labels: (pull.labels ?? []).map((label) => label.name),
  });

  return {
    name: 'github',
    noun: 'pull request',
    references: {
      prefix: '#',
      url: (number) => `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repository}/pull/${number}`,
    },
    missing,
    async currentPull() {
      if (!env.GITHUB_EVENT_PATH) return null;
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
      return event.pull_request ? toPull(event.pull_request) : null;
    },
    async listFiles(number) {
      const files = await paginate(get, `/pulls/${number}/files`);
      return files.map((file) => ({ path: file.filename, removed: file.status === 'removed' }));
    },
    async findMergedPull(sha) {
      const pulls = await get(`/commits/${sha}/pulls`);
      const merged = pulls.find((pull) => pull.merged_at);
      return merged ? toPull(merged) : null;
    },
  };
}

/**
 * GitLab needs a token in `GITLAB_TOKEN` (`read_api` scope): `CI_JOB_TOKEN`
 * cannot read merge requests.
 * @param {PlatformIo} io
 * @returns {Platform}
 */
export function gitlab(io) {
  const { env } = io;
  const unset = ['CI_API_V4_URL', 'CI_PROJECT_ID', 'CI_PROJECT_URL', 'GITLAB_TOKEN'].filter((name) => !env[name]);
  let missing = null;
  if (unset.length > 0) {
    missing = `${unset.join(', ')} ${unset.length > 1 ? 'are' : 'is'} not set`;
    if (unset.includes('GITLAB_TOKEN')) {
      missing += ' (GITLAB_TOKEN needs a token with the read_api scope: CI_JOB_TOKEN cannot read merge requests)';
    }
  }

  /** @param {string} path Path under the project, starting with `/`. */
  async function get(path) {
    if (missing) throw new Error(`${missing}: cannot read merge requests from the GitLab API.`);
    const url = `/projects/${encodeURIComponent(env.CI_PROJECT_ID)}${path}`;
    const response = await io.fetch(`${env.CI_API_V4_URL}${url}`, { headers: { 'PRIVATE-TOKEN': env.GITLAB_TOKEN } });
    if (!response.ok) throw new Error(`GitLab API ${url} answered ${response.status}.`);
    return response.json();
  }

  /** @returns {Pull} */
  const toPull = (mr) => ({ number: mr.iid, title: mr.title, author: mr.author?.username, labels: mr.labels ?? [] });

  return {
    name: 'gitlab',
    noun: 'merge request',
    references: { prefix: '!', url: (number) => `${env.CI_PROJECT_URL}/-/merge_requests/${number}` },
    missing,
    async currentPull() {
      if (!env.CI_MERGE_REQUEST_IID) return null;
      return toPull(await get(`/merge_requests/${env.CI_MERGE_REQUEST_IID}`));
    },
    async listFiles(number) {
      const diffs = await paginate(get, `/merge_requests/${number}/diffs`);
      return diffs.map((diff) => ({ path: diff.new_path, removed: diff.deleted_file === true }));
    },
    async findMergedPull(sha) {
      const mrs = await get(`/repository/commits/${sha}/merge_requests`);
      const merged = mrs.find((mr) => mr.state === 'merged');
      return merged ? toPull(merged) : null;
    },
  };
}
