import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitError } from './errors.js';
import {
  createGit,
  findAddingCommit,
  listChangedFiles,
  listCommitsSince,
  listTags,
} from './git.js';
import { makeDirectory, tableGit } from './test-utils.js';

function repository(): { cwd: string; run: (...args: string[]) => string } {
  const cwd = makeDirectory();
  const run = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    }).trim();
  run('init', '--quiet', '--initial-branch=main');
  return { cwd, run };
}

function commit(cwd: string, run: (...args: string[]) => string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(cwd, path), text);
  run('add', '--all');
  run('commit', '--quiet', '--message', Object.keys(files).join(' '));
  return run('rev-parse', 'HEAD');
}

describe('createGit', () => {
  it('returns stdout and puts stderr in the hint of a failure', async () => {
    const { cwd } = repository();
    const git = createGit(cwd);
    expect(await git(['rev-parse', '--is-inside-work-tree'])).toBe('true\n');
    const error = await git(['rev-parse', 'nope']).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toBe('git rev-parse nope failed.');
    expect((error as GitError).hint).toContain('nope');
  });

  it('has no hint when git prints nothing', async () => {
    const cwd = makeDirectory({ a: '1', b: '2' });
    const error = await createGit(cwd)(['diff', '--quiet', '--no-index', 'a', 'b']).catch(
      (reason: unknown) => reason,
    );
    expect((error as GitError).hint).toBeUndefined();
  });
});

describe('git helpers on a repository', () => {
  it('list changed files, the adding commit, tags and commits', async () => {
    const { cwd, run } = repository();
    const base = commit(cwd, run, { 'a.txt': 'a', 'old.txt': 'old' });
    run('tag', '1.0.0');
    run('checkout', '--quiet', '-b', 'feature');
    run('rm', '--quiet', 'old.txt');
    const second = commit(cwd, run, { 'café.txt': 'b' });
    const git = createGit(cwd);

    expect(await listChangedFiles(git, base)).toEqual([
      { path: 'café.txt', removed: false },
      { path: 'old.txt', removed: true },
    ]);
    expect(await findAddingCommit(git, 'café.txt')).toEqual({
      sha: second,
      time: expect.any(Number),
    });
    expect(await findAddingCommit(git, 'missing.txt')).toBeNull();
    expect(await listCommitsSince(git, '1.0.0')).toEqual([second]);
    run('tag', 'v1.1.0');
    expect(await listTags(git)).toEqual(['1.0.0', 'v1.1.0']);
  });

  it('lists no tag in a repository without tags', async () => {
    const { cwd, run } = repository();
    commit(cwd, run, { 'a.txt': 'a' });
    expect(await listTags(createGit(cwd))).toEqual([]);
  });

  it('explains a missing base commit', async () => {
    const { cwd, run } = repository();
    commit(cwd, run, { 'a.txt': 'a' });
    const error = await listChangedFiles(createGit(cwd), 'f'.repeat(40)).catch(
      (reason: unknown) => reason,
    );
    expect((error as GitError).message).toMatch(
      /^Cannot list the files changed since f{40}: fatal/,
    );
    expect((error as GitError).hint).toContain('fetch-depth: 0');
    expect((error as GitError).hint).toContain('GIT_DEPTH');
  });

  it('keeps the message short when the failure has no detail', async () => {
    const error = await listChangedFiles(tableGit({}), 'abc').catch((reason: unknown) => reason);
    expect((error as GitError).message).toBe('Cannot list the files changed since abc.');
  });
});
