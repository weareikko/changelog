import { GitHubApiError } from './errors.js';

/** The fields of a GitHub pull request that the tool reads. */
export interface GitHubPull {
  number: number;
  title: string;
  merged_at: string | null;
  user?: { login?: string } | null;
  labels?: { name?: string }[];
  base?: { ref?: string } | null;
}

export interface GitHubClientOptions {
  apiUrl: string;
  /** `owner/repo`. */
  repository: string;
  token: string;
  fetch?: typeof fetch;
}

const ACCESS_HINT =
  'The token (GITHUB_TOKEN or --github-token) needs the contents: read and pull-requests: read permissions. ' +
  'In a workflow, set them in `permissions:`.';

/**
 * Explicit GitHub REST client for the one read endpoint the tool needs. The
 * token goes in the `Authorization` header and no error message contains it.
 */
export class GitHubClient {
  private readonly options: GitHubClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.options.apiUrl.replace(/\/$/, '')}/repos/${this.options.repository}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers });
    } catch (error) {
      throw new GitHubApiError(`Cannot reach the GitHub API at ${this.options.apiUrl}.`, {
        path,
        cause: error,
        hint: 'Check GITHUB_API_URL and the network of the job.',
      });
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 200).trim();
      throw new GitHubApiError(
        `GitHub API GET /repos/${this.options.repository}${path} answered ${response.status}${body ? `: ${body}` : '.'}`,
        {
          path,
          status: response.status,
          hint: [401, 403, 404].includes(response.status)
            ? ACCESS_HINT
            : 'GitHub could not answer. Retry the job.',
        },
      );
    }
    return (await response.json()) as T;
  }

  /** `GET /repos/:owner/:repo/commits/:sha/pulls` */
  listCommitPulls(sha: string): Promise<GitHubPull[]> {
    return this.get(`/commits/${encodeURIComponent(sha)}/pulls`);
  }
}
