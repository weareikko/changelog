import type { References } from '../changelog.js';
import type { GitHubConfig } from '../config.js';
import { ConfigError } from '../errors.js';
import { GitHubClient } from '../github.js';
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

  async findMergedChange(sha: string): Promise<MergedChange | null> {
    if (this.unavailable) {
      throw new ConfigError(`${this.unavailable}: cannot read pull requests.`, {
        hint: 'Run in GitHub Actions, or set GITHUB_REPOSITORY (owner/repo) and GITHUB_TOKEN.',
      });
    }
    const pulls = await this.client.listCommitPulls(sha);
    const merged = pulls.find(
      (pull) => pull.merged_at && (!this.config.branch || pull.base?.ref === this.config.branch),
    );
    if (!merged) return null;
    return {
      number: merged.number,
      title: merged.title,
      author: merged.user?.login,
      labels: (merged.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
    };
  }
}
