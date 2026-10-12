import type { GitLabAuthHeader, GitLabTokenSource } from './config.js';
import { GitLabApiError } from './errors.js';

/** The fields of a GitLab merge request that the tool reads. */
export interface GitLabMergeRequest {
  iid: number;
  title: string;
  state: string;
  target_branch: string;
  source_branch: string;
  author?: { username?: string } | null;
  labels?: string[];
  /** Only on `GET /projects/:id/merge_requests/:iid`. */
  diff_refs?: { base_sha?: string | null } | null;
}

export interface GitLabClientOptions {
  /** Instance URL without `/api/v4`. */
  url: string;
  /** Project ID or path. */
  project: string;
  token: string;
  authHeader: GitLabAuthHeader;
  tokenSource: GitLabTokenSource | null;
  fetch?: typeof fetch;
}

const ROLE = 'a project access token with the read_api scope and the Reporter role';

/**
 * What to do about a refused request. GitLab answers 404 instead of 403 when
 * the token cannot see the project, so 401, 403 and 404 share these hints.
 */
export function gitlabAccessHint(tokenSource: GitLabTokenSource | null, project: string): string {
  if (tokenSource === null) {
    return `No GitLab token. Run in a GitLab CI job (CI_JOB_TOKEN), or set GITLAB_TOKEN to ${ROLE}.`;
  }
  if (tokenSource === 'CI_JOB_TOKEN') {
    return (
      'CI_JOB_TOKEN reads merge requests and the merge requests of a commit on GitLab 18.4 or later, ' +
      'with the role of the user who started the pipeline (Reporter or higher). ' +
      `On an older GitLab, or for another project, set GITLAB_TOKEN to ${ROLE}.`
    );
  }
  return (
    `${tokenSource} needs the read_api scope and the Reporter role (or higher) on project "${project}", ` +
    'and must not be expired. Check --project (or CI_PROJECT_ID). ' +
    'A protected CI/CD variable only reaches pipelines of protected branches and tags.'
  );
}

/**
 * Explicit GitLab REST client for the three read endpoints the tool needs.
 * The token goes in a header (`PRIVATE-TOKEN` or `JOB-TOKEN`), never in the
 * URL, and no error message contains it.
 */
export class GitLabClient {
  private readonly base: string;
  private readonly project: string;
  private readonly options: GitLabClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitLabClientOptions) {
    this.options = options;
    this.base = `${options.url.replace(/\/$/, '')}/api/v4`;
    this.project = `/projects/${encodeURIComponent(options.project)}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.options.token) headers[this.options.authHeader] = this.options.token;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers });
    } catch (error) {
      throw new GitLabApiError(`Cannot reach the GitLab API at ${this.base}.`, {
        path,
        cause: error,
        hint: 'Check --gitlab-url (or CI_SERVER_URL) and the network of the job.',
      });
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 200).trim();
      const denied = [401, 403, 404].includes(response.status);
      throw new GitLabApiError(
        `GitLab API GET ${path} answered ${response.status}${body ? `: ${body}` : '.'}`,
        {
          path,
          status: response.status,
          hint: denied
            ? gitlabAccessHint(this.options.tokenSource, this.options.project)
            : 'GitLab could not answer. Retry the job, or check --gitlab-url (or CI_SERVER_URL).',
        },
      );
    }
    return (await response.json()) as T;
  }

  /** `GET /projects/:id/merge_requests/:iid` */
  getMergeRequest(iid: string | number): Promise<GitLabMergeRequest> {
    return this.get(`${this.project}/merge_requests/${encodeURIComponent(String(iid))}`);
  }

  /** `GET /projects/:id/merge_requests?source_branch=…&state=opened`, newest first. */
  listOpenMergeRequests(sourceBranch: string): Promise<GitLabMergeRequest[]> {
    return this.get(`${this.project}/merge_requests`, {
      source_branch: sourceBranch,
      state: 'opened',
      per_page: '100',
    });
  }

  /** `GET /projects/:id/repository/commits/:sha/merge_requests` */
  listCommitMergeRequests(sha: string): Promise<GitLabMergeRequest[]> {
    return this.get(`${this.project}/repository/commits/${encodeURIComponent(sha)}/merge_requests`);
  }
}
