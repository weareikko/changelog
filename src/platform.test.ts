import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { createPlatform } from './platform.js';
import { GitHubPlatform } from './platforms/github.js';
import { GitLabPlatform } from './platforms/gitlab.js';
import { tableGit } from './test-utils.js';

describe('createPlatform', () => {
  it('builds the platform of the config', () => {
    const git = tableGit({});
    expect(createPlatform(resolveConfig(['check'], {}), fetch, git)).toBeInstanceOf(GitHubPlatform);
    expect(
      createPlatform(resolveConfig(['check'], { GITLAB_CI: 'true' }), fetch, git),
    ).toBeInstanceOf(GitLabPlatform);
  });
});
