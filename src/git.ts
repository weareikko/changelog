import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitError } from './errors.js';

const exec = promisify(execFile);

/** Run git with these arguments and return its stdout. */
export type Git = (args: string[]) => Promise<string>;

export interface ChangedFile {
  path: string;
  removed: boolean;
}

/**
 * A {@link Git} that runs the `git` binary in `cwd`. The stderr of a failed
 * command goes into the error hint, not to the job log.
 */
export function createGit(cwd: string): Git {
  return async (args) => {
    try {
      const { stdout } = await exec('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new GitError(`git ${args.join(' ')} failed.`, {
        cause: error,
        hint: stderr || undefined,
      });
    }
  };
}

/**
 * The files that HEAD changes since its merge base with `base`, as
 * `git diff <base>...HEAD` lists them. Renames count as a removal and an
 * addition.
 */
export async function listChangedFiles(git: Git, base: string): Promise<ChangedFile[]> {
  let output: string;
  try {
    output = await git([
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
      `${base}...HEAD`,
    ]);
  } catch (error) {
    const detail = error instanceof GitError && error.hint ? `: ${error.hint.split('\n')[0]}` : '.';
    throw new GitError(`Cannot list the files changed since ${base}${detail}`, {
      cause: error,
      hint:
        'The clone needs that commit and the history up to HEAD. ' +
        'On GitHub, check out with `fetch-depth: 0`. ' +
        'On GitLab, set GIT_DEPTH to more than the number of commits of the merge request (0 for the full history).',
    });
  }
  const fields = output.split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    files.push({ path: fields[index + 1], removed: fields[index] === 'D' });
  }
  return files;
}

/** The commit that added `file`, and its commit time, or null. */
export async function findAddingCommit(
  git: Git,
  file: string,
): Promise<{ sha: string; time: number } | null> {
  const output = await git(['log', '--diff-filter=A', '--format=%H %ct', '-1', '--', file]);
  const [sha, time] = output.trim().split(' ');
  return sha ? { sha, time: Number(time) } : null;
}

/** The first-parent commits from `tag` (excluded) to HEAD, oldest first. */
export async function listCommitsSince(git: Git, tag: string): Promise<string[]> {
  const output = await git(['log', '--first-parent', '--format=%H', `${tag}..HEAD`]);
  return output.split('\n').filter(Boolean).toReversed();
}

/** The tags reachable from HEAD. */
export async function listTags(git: Git): Promise<string[]> {
  const output = await git(['tag', '--merged', 'HEAD']);
  return output.split('\n').filter(Boolean);
}
