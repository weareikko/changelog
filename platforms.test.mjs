import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPlatform, detectPlatform } from './platforms.mjs';

describe('detectPlatform', () => {
  it('uses gitlab in GitLab CI only', () => {
    assert.equal(detectPlatform({ GITLAB_CI: 'true' }), 'gitlab');
    assert.equal(detectPlatform({ GITHUB_ACTIONS: 'true' }), 'github');
    assert.equal(detectPlatform({ GITHUB_ACTIONS: 'true', GITLAB_CI: 'true' }), 'github');
    assert.equal(detectPlatform({}), 'github');
  });
});

describe('createPlatform', () => {
  const io = { env: { GITHUB_REPOSITORY: 'acme/repo', CI_PROJECT_URL: 'https://gitlab.test/acme/repo' }, fetch };

  it('writes GitHub references', () => {
    const platform = createPlatform('github', io);
    assert.equal(platform.references.prefix, '#');
    assert.equal(platform.references.url(3), 'https://github.com/acme/repo/pull/3');
    assert.equal(
      createPlatform('github', { env: { ...io.env, GITHUB_SERVER_URL: 'https://ghe.test' }, fetch }).references.url(3),
      'https://ghe.test/acme/repo/pull/3',
    );
  });

  it('writes GitLab references', () => {
    const platform = createPlatform('gitlab', io);
    assert.equal(platform.references.prefix, '!');
    assert.equal(platform.references.url(3), 'https://gitlab.test/acme/repo/-/merge_requests/3');
  });

  it('reads the GitHub API URL from GITHUB_API_URL', async () => {
    const urls = [];
    const platform = createPlatform('github', {
      env: { GITHUB_REPOSITORY: 'acme/repo', GITHUB_API_URL: 'https://ghe.test/api/v3' },
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, json: async () => [] };
      },
    });
    assert.equal(await platform.findMergedPull('abc'), null);
    assert.deepEqual(urls, ['https://ghe.test/api/v3/repos/acme/repo/commits/abc/pulls']);
  });
});
