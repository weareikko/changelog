import type { References } from '../changelog.js';
import type { GitHubConfig } from '../config.js';
import { ConfigError } from '../errors.js';
import { GitHubClient, type GitHubPull } from '../github.js';
import type { Change, MergedChange, Platform } from '../platform.js';

/**
 * GitHub Actions: the pull request, its labels, author and base commit come
 * from the event payload (`GITHUB_EVENT_PATH`). Only `release` calls the API.
 */
export class GitHubPlatform implements Platform {
  readonly name = 'github';
  readonly noun = 'pull request';
  readonly unavailable: string | null;
  readonly references: References;
  private readonly config: GitHubConfig;
  private readonly client: GitHubClient;
  /** The files of each pull request, and the merged pull requests based on each branch. */
  private readonly pullFiles = new Map<number, Promise<string[]>>();
  private readonly stackedPulls = new Map<string, Promise<GitHubPull[]>>();

  constructor(config: GitHubConfig, fetchImpl: typeof fetch) {
    this.config = config;
    this.unavailable = config.repository ? null : 'GITHUB_REPOSITORY is not set';
    this.references = {
      prefix: '#',
      url: (number) => `${config.serverUrl}/${config.repository}/pull/${number}`,
    };
    this.client = new GitHubClient({
      apiUrl: config.apiUrl,
      repository: config.repository,
      token: config.token,
      fetch: fetchImpl,
    });
  }

  async currentChange(): Promise<Change | null> {
    const pull = this.config.pull;
    if (!pull) return null;
    if (!pull.baseSha) {
      throw new ConfigError(`The event payload of pull request #${pull.number} has no base SHA.`);
    }
    return {
      number: pull.number,
      labels: pull.labels,
      baseSha: pull.baseSha,
      author: () => Promise.resolve(pull.author),
    };
  }

  async findMergedChange(sha: string, file?: string): Promise<MergedChange | null> {
    if (this.unavailable) {
      throw new ConfigError(`${this.unavailable}: cannot read pull requests.`, {
        hint: 'Run in GitHub Actions, or set GITHUB_REPOSITORY (owner/repo) and GITHUB_TOKEN.',
      });
    }
    const pulls = await this.client.listCommitPulls(sha);
    const mergedPulls = pulls.filter((pull) => pull.merged_at);
    // `gh stack merge` merges a stack into the trunk but keeps the base branch of each pull
    // request: the commit is in the history of the current branch, so any merged pull request
    // fits when none has the current branch as its base.
    const found =
      mergedPulls.find((pull) => pull.base?.ref === this.config.branch) ?? mergedPulls[0];
    if (!found) return null;
    const merged = (file ? await this.findAddingPull(found, file) : null) ?? found;
    return {
      number: merged.number,
      title: merged.title,
      author: merged.user?.login,
      labels: (merged.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
    };
  }

  /**
   * `pull`, or the first merged pull request stacked on it (based on its head branch, or on
   * the head branch of such a pull request), whose files include `file`, or null. After
   * `gh stack merge`, GitHub links every commit of the stack to its bottom pull request.
   */
  private async findAddingPull(pull: GitHubPull, file: string): Promise<GitHubPull | null> {
    const queue = [pull];
    const seen = new Set<number>();
    for (const candidate of queue) {
      if (seen.has(candidate.number)) continue;
      seen.add(candidate.number);
      if ((await this.listFiles(candidate.number)).includes(file)) return candidate;
      if (candidate.head?.ref) queue.push(...(await this.listStacked(candidate.head.ref)));
    }
    return null;
  }

  private listFiles(number: number): Promise<string[]> {
    let files = this.pullFiles.get(number);
    if (!files) {
      files = this.client.listPullFiles(number);
      this.pullFiles.set(number, files);
    }
    return files;
  }

  private listStacked(branch: string): Promise<GitHubPull[]> {
    let pulls = this.stackedPulls.get(branch);
    if (!pulls) {
      pulls = this.client
        .listClosedPulls(branch)
        .then((closed) => closed.filter((pull) => pull.merged_at));
      this.stackedPulls.set(branch, pulls);
    }
    return pulls;
  }
}
