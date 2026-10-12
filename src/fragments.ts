import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FileIssue,
  FRAGMENTS_DIRECTORY,
  isFragmentPath,
  parsePrerelease,
  PRERELEASE_FILE,
} from './changelog.js';
import { ConfigError } from './errors.js';

export interface FragmentFile {
  /** Path relative to the working directory, e.g. `.changelog/ssh-sync.md`. */
  file: string;
  text: string;
}

/** Read the fragments of `.changelog/`, sorted by name. */
export function readFragments(cwd: string): FragmentFile[] {
  const directory = join(cwd, FRAGMENTS_DIRECTORY);
  if (!existsSync(directory)) {
    throw new ConfigError(`No ${FRAGMENTS_DIRECTORY}/ directory.`, {
      hint: `Create it with a ${FRAGMENTS_DIRECTORY}/.gitkeep file to start using fragments.`,
    });
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${FRAGMENTS_DIRECTORY}/${entry.name}`)
    .filter(isFragmentPath)
    .toSorted()
    .map((file) => ({ file, text: readFileSync(join(cwd, file), 'utf8') }));
}

/**
 * The prerelease identifier of `.changelog/prerelease`, or null without the
 * file, with the errors of an invalid file.
 */
export function readPrerelease(cwd: string): { id: string | null; errors: FileIssue[] } {
  const path = join(cwd, PRERELEASE_FILE);
  if (!existsSync(path)) return { id: null, errors: [] };
  return parsePrerelease(readFileSync(path, 'utf8'), PRERELEASE_FILE);
}
