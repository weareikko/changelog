import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRelease,
  formatSection,
  FRAGMENTS_DIRECTORY,
  insertSection,
  type ReleaseFragment,
  type ReleasePull,
} from './changelog.js';
import type { Config } from './config.js';
import { ConfigError } from './errors.js';
import { readFragments } from './fragments.js';
import { findAddingCommit, listCommitsSince } from './git.js';
import {
  formatDotenv,
  reportIssues,
  type Runtime,
  setGitHubOutputs,
  warn,
  writeOutputFile,
} from './output.js';
import type { Platform } from './platform.js';
import { AUTO_VERSION, findVersionTag, nextVersion, resolveCurrentVersion } from './version.js';

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

  const tag = await findVersionTag(runtime.git);
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

/**
 * `version` is the released version: the given one, or with `--version auto`
 * the computed one (empty when there is nothing to release).
 */
function writeOutputs(config: Config, runtime: Runtime, version: string, body: string): void {
  const changed = String(body !== '');
  setGitHubOutputs(runtime, { changed, version, body });
  if (config.dotenv) {
    writeOutputFile(
      runtime,
      config.dotenv,
      formatDotenv({ CHANGELOG_CHANGED: changed, CHANGELOG_VERSION: version }),
    );
  }
  if (config.notesFile) writeOutputFile(runtime, config.notesFile, body ? `${body}\n` : '');
}

/**
 * Fold the fragments, and the changes of `skipAuthors` merged since the
 * previous tag, into a new CHANGELOG.md section, and delete the fragments.
 * With `--version auto`, the entries give the next version. Returns the exit
 * code.
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
  const { body, change, used, errors } = buildRelease({
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

  const auto = config.version === AUTO_VERSION;
  if (body === null || change === null) {
    runtime.stdout(
      `No fragment in ${FRAGMENTS_DIRECTORY}/ and no ${platform.noun} from skip-authors: CHANGELOG.md is unchanged.`,
    );
    writeOutputs(config, runtime, auto ? '' : config.version, '');
    return 0;
  }

  let version = config.version;
  if (auto) {
    const current = await resolveCurrentVersion(config.current, runtime.git);
    version = nextVersion(current, change);
    runtime.stdout(`Version ${version}: ${change} change since ${current}.`);
  }
  const section = formatSection(version, config.date, body);

  const changelogPath = join(runtime.cwd, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    throw new ConfigError('CHANGELOG.md not found.', {
      hint: 'Commit a CHANGELOG.md before the first release.',
    });
  }
  writeFileSync(
    changelogPath,
    insertSection(readFileSync(changelogPath, 'utf8'), section, version),
  );
  for (const file of used) rmSync(join(runtime.cwd, file));

  runtime.stdout(section);
  writeOutputs(config, runtime, version, body);
  return 0;
}
