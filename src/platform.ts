import type { References } from './changelog.js';
import type { Config } from './config.js';
import { GitHubPlatform } from './platforms/github.js';
import { GitLabPlatform } from './platforms/gitlab.js';

/** The pull or merge request that a `check` run is for. */
export interface Change {
  /** Pull request number (GitHub) or merge request IID (GitLab). */
  number: number;
  labels: string[];
  /** The commit the change starts from: `git diff <baseSha>...HEAD` lists its files. */
  baseSha: string;
  /** Login (GitHub) or username (GitLab). Can need an API call. */
  author(): Promise<string | undefined>;
}

/** A merged pull or merge request, for `release`. */
export interface MergedChange {
  number: number;
  title: string;
  author: string | undefined;
  labels: string[];
}

/**
 * The seam between the commands and GitHub or GitLab. Both platforms share
 * one flow: the run's change comes from the CI environment (with an API call
 * only where the environment lacks a field), its files come from local git,
 * and `release` asks the API which merged change added a commit.
 */
export interface Platform {
  name: Config['platform'];
  /** `pull request` or `merge request`, for messages. */
  noun: string;
  /**
   * `#` and `<repository>/pull/N`, or `!` and `<project>/-/merge_requests/N`.
   * Read it only when {@link Platform.unavailable} is null.
   */
  references: References;
  /** Why the API cannot be used (a missing variable or token), or null. */
  unavailable: string | null;
  /** The open change of this run, or null when the run is for none. */
  currentChange(): Promise<Change | null>;
  /**
   * The merged change that contains `sha`, or null. A change merged into the
   * current branch comes first; a stacked change merged into another branch
   * also counts. With `file`, the fragment that `sha` added: on GitHub, the
   * change whose files include it, which can be a pull request stacked on the
   * one found.
   */
  findMergedChange(sha: string, file?: string): Promise<MergedChange | null>;
}

export function createPlatform(config: Config, fetchImpl: typeof fetch): Platform {
  return config.platform === 'gitlab'
    ? new GitLabPlatform(config.gitlab, fetchImpl)
    : new GitHubPlatform(config.github, fetchImpl);
}
