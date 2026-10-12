import { describe, expect, it } from 'vitest';
import { ConfigError, formatError, GitError, GitHubApiError, GitLabApiError } from './errors.js';

describe('errors', () => {
  it('carry a code, a hint and the request path', () => {
    const cause = new Error('cause');
    const error = new GitLabApiError('Denied.', { path: '/x', status: 403, hint: 'Fix', cause });
    expect(error).toMatchObject({ name: 'GitLabApiError', code: 'GITLAB_API_ERROR', path: '/x' });
    expect(error.status).toBe(403);
    expect(error.cause).toBe(cause);
    expect(new GitHubApiError('x', { path: '/y' })).toMatchObject({
      code: 'GITHUB_API_ERROR',
      path: '/y',
      status: undefined,
    });
    expect(new GitError('x').code).toBe('GIT_ERROR');
    expect(new ConfigError('x').hint).toBeUndefined();
  });

  it('format with the code and the hint', () => {
    expect(formatError(new ConfigError('Missing --version.', { hint: 'Pass it.' }))).toBe(
      '[CONFIG_ERROR] Missing --version.\nHint: Pass it.',
    );
    expect(formatError(new GitError('git failed.'))).toBe('[GIT_ERROR] git failed.');
    expect(formatError(new Error('plain'))).toBe('plain');
    expect(formatError('text')).toBe('text');
  });
});
