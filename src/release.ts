import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRelease,
  FRAGMENTS_DIRECTORY,
  insertSection,
  type ReleaseFragment,
  type ReleasePull,
} from './changelog.js';
import type { Config } from './config.js';
import { ConfigError } from './errors.js';
import { readFragments } from './fragments.js';
import { findAddingCommit, findPreviousTag, listCommitsSince } from './git.js';
import {
  formatDotenv,
  reportIssues,
  type Runtime,
  setGitHubOutputs,
  warn,
  writeOutputFile,
} from './output.js';
import type { Platform } from './platform.js';

interface DatedFragment extends ReleaseFragment {
  time: number;
}

/** Each non-empty fragment with the merged change that added it, oldest first. */
async function resolveFragments(platform: Platform, runtime: Runtime): Promise<DatedFragment[]> {
  const fragments: DatedFragment[] = [];
  for (const { file, text } of readFragments(runtime.cwd)) {
    if (text.trim() === '') continue;
    const commit = await findAddingCommit(runtime.git, file);
    if (!commit) {
      fragments.push({ file, text, pr: null, time: Number.POSITIVE_INFINITY });
      continue;
    }
    const merged = platform.unavailable ? null : await platform.findMergedChange(commit.sha);
    fragments.push({ file, text, pr: merged?.number ?? null, time: commit.time });
  }
  return fragments.toSorted((a, b) => a.time - b.time || a.file.localeCompare(b.file));
}

/**
 * The changes of `skipAuthors` merged since the previous tag, on the
 * first-parent history of HEAD, oldest first, without the ones with the skip
 * label.
 */
async function listAuthorChanges(
  config: Config,
  platform: Platform,
  runtime: Runtime,
): Promise<ReleasePull[]> {
  if (config.skipAuthors.length === 0 || platform.unavailable) return [];

  const tag = await findPreviousTag(runtime.git);
  if (!tag) {
    runtime.stdout(`No previous tag: no ${platform.noun} from skip-authors to add.`);
    return [];
  }

  const changes = new Map<number, ReleasePull>();
  for (const sha of await listCommitsSince(runtime.git, tag)) {
    const change = await platform.findMergedChange(sha);
    if (
      !change ||
      changes.has(change.number) ||
      !change.author ||
      !config.skipAuthors.includes(change.author) ||
      change.labels.includes(config.skipLabel)
    ) {
      continue;
    }
    changes.set(change.number, { number: change.number, title: change.title });
  }
  return [...changes.values()];
}

function writeOutputs(config: Config, runtime: Runtime, changed: boolean, body: string): void {
  setGitHubOutputs(runtime, { changed: String(changed), body });
  if (config.dotenv) {
    writeOutputFile(
      runtime,
      config.dotenv,
      formatDotenv({ CHANGELOG_CHANGED: String(changed), CHANGELOG_VERSION: config.version }),
    );
  }
  if (config.notesFile) writeOutputFile(runtime, config.notesFile, body ? `${body}\n` : '');
}

/**
 * Fold the fragments, and the changes of `skipAuthors` merged since the
 * previous tag, into a new CHANGELOG.md section, and delete the fragments.
 * Returns the exit code.
 */
export async function release(
  config: Config,
  platform: Platform,
  runtime: Runtime,
): Promise<number> {
  if (platform.unavailable) {
    warn(
      runtime,
      `${platform.unavailable}: no ${platform.noun} references and no entries from skip-authors.`,
    );
  }

  const fragments = await resolveFragments(platform, runtime);
  const pulls = await listAuthorChanges(config, platform, runtime);
  const { section, body, used, errors } = buildRelease({
    version: config.version,
    date: config.date,
    sections: config.sections,
    references: platform.references,
    fragments,
    pulls,
  });

  if (errors.length > 0) {
    reportIssues(runtime, errors);
    runtime.stderr(`Invalid fragments: CHANGELOG.md and ${FRAGMENTS_DIRECTORY}/ are unchanged.`);
    return 1;
  }

  if (section === null) {
    runtime.stdout(
      `No fragment in ${FRAGMENTS_DIRECTORY}/ and no ${platform.noun} from skip-authors: CHANGELOG.md is unchanged.`,
    );
    writeOutputs(config, runtime, false, '');
    return 0;
  }

  const changelogPath = join(runtime.cwd, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    throw new ConfigError('CHANGELOG.md not found.', {
      hint: 'Commit a CHANGELOG.md before the first release.',
    });
  }
  writeFileSync(
    changelogPath,
    insertSection(readFileSync(changelogPath, 'utf8'), section, config.version),
  );
  for (const file of used) rmSync(join(runtime.cwd, file));

  runtime.stdout(section);
  writeOutputs(config, runtime, true, body);
  return 0;
}
