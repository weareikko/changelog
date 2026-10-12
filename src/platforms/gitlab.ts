import type { References } from '../changelog.js';
import type { GitLabConfig } from '../config.js';
import { ConfigError } from '../errors.js';
import { GitLabClient, type GitLabMergeRequest } from '../gitlab.js';
import type { Change, MergedChange, Platform } from '../platform.js';

/** Why the GitLab API cannot be used, or null. */
function findUnavailable(config: GitLabConfig): string | null {
  const unset: string[] = [];
  if (!config.url) unset.push('CI_SERVER_URL (or --gitlab-url)');
  if (!config.project) unset.push('CI_PROJECT_ID (or --project)');
  if (!config.token) unset.push('a token (GITLAB_TOKEN, GLAB_CLI_TOKEN or CI_JOB_TOKEN)');
  if (unset.length > 0) return `Missing ${unset.join(', ')}`;
  if (!config.projectUrl) return 'Missing CI_PROJECT_URL: pass --project as a path (group/project)';
  return null;
}

/**
 * GitLab CI: a merge request pipeline gives the IID, the labels and the diff
 * base in its variables, so `check` reads the API for the author only. A
 * branch pipeline finds the open merge request of its branch with the API.
 */
export class GitLabPlatform implements Platform {
  readonly name = 'gitlab';
  readonly noun = 'merge request';
  readonly unavailable: string | null;
  readonly references: References;
  private readonly config: GitLabConfig;
  private readonly client: GitLabClient;

  constructor(config: GitLabConfig, fetchImpl: typeof fetch) {
    this.config = config;
    this.unavailable = findUnavailable(config);
    this.references = {
      prefix: '!',
      url: (number) => `${config.projectUrl}/-/merge_requests/${number}`,
    };
    this.client = new GitLabClient({
      url: config.url,
      project: config.project,
      token: config.token,
      authHeader: config.authHeader,
      tokenSource: config.tokenSource,
      fetch: fetchImpl,
    });
  }

  private api(): GitLabClient {
    if (this.unavailable) {
      throw new ConfigError(`${this.unavailable}: cannot read merge requests.`, {
        hint: 'Run in GitLab CI, or pass --gitlab-url, --project and --gitlab-token (or GITLAB_TOKEN).',
      });
    }
    return this.client;
  }

  private fromMergeRequest(mr: GitLabMergeRequest): Change {
    const baseSha = mr.diff_refs?.base_sha;
    if (!baseSha) {
      throw new ConfigError(`Merge request !${mr.iid} has no diff base yet.`, {
        hint: 'GitLab computes it after the first push: retry the job.',
      });
    }
    return {
      number: mr.iid,
      labels: mr.labels ?? [],
      baseSha,
      author: () => Promise.resolve(mr.author?.username),
    };
  }

  async currentChange(): Promise<Change | null> {
    const { mr, mrLabels, mrBaseSha, branch } = this.config;

    // Merge request pipeline: everything but the author is in the variables.
    if (mr && mrLabels !== null && mrBaseSha) {
      let author: Promise<string | undefined> | undefined;
      return {
        number: Number(mr),
        labels: mrLabels,
        baseSha: mrBaseSha,
        author: () => {
          author ??= this.api()
            .getMergeRequest(mr)
            .then((request) => request.author?.username);
          return author;
        },
      };
    }

    if (mr) return this.fromMergeRequest(await this.api().getMergeRequest(mr));

    // Branch pipeline: the open merge request of the branch, if any.
    if (!branch) return null;
    const [open] = await this.api().listOpenMergeRequests(branch);
    if (!open) return null;
    return this.fromMergeRequest(await this.api().getMergeRequest(open.iid));
  }

  async findMergedChange(sha: string): Promise<MergedChange | null> {
    const requests = await this.api().listCommitMergeRequests(sha);
    const mergedRequests = requests.filter((request) => request.state === 'merged');
    // A merge request of a stack can target the branch of the merge request below it: the
    // commit is in the history of the current branch, so any merged merge request fits when
    // none targets the current branch.
    const merged =
      mergedRequests.find((request) => request.target_branch === this.config.branch) ??
      mergedRequests[0];
    if (!merged) return null;
    return {
      number: merged.iid,
      title: merged.title,
      author: merged.author?.username,
      labels: merged.labels ?? [],
    };
  }
}
