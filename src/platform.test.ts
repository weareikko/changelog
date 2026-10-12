import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { createPlatform } from './platform.js';
import { GitHubPlatform } from './platforms/github.js';
import { GitLabPlatform } from './platforms/gitlab.js';

describe('createPlatform', () => {
  it('builds the platform of the config', () => {
    expect(createPlatform(resolveConfig(['check'], {}), fetch)).toBeInstanceOf(GitHubPlatform);
    expect(createPlatform(resolveConfig(['check'], { GITLAB_CI: 'true' }), fetch)).toBeInstanceOf(
      GitLabPlatform,
    );
  });
});
