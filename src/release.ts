import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRelease,
  type ChangeLevel,
  formatSection,
  FRAGMENTS_DIRECTORY,
  insertSection,
  PRERELEASE_FILE,
  type ReleaseFragment,
  STABLE_RELEASE,
  type ReleasePull,
} from './changelog.js';
import type { Config } from './config.js';
import { ConfigError } from './errors.js';
import { readFragments, readPrerelease } from './fragments.js';
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
import {
  type Bump,
  CALVER_VERSION,
  findVersionTag,
  isBump,
  isComputedVersion,
  nextCalVer,
  nextVersion,
  resolveVersions,
} from './version.js';

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
 * or a bump the computed one (empty when there is nothing to release).
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
 * The version and body of an `--version auto`, `calver` or bump release, or
 * null when there is nothing to release. A stable release that promotes a
 * prerelease without new entries gets a one-line body.
 */
async function computedRelease(
  config: Config,
  runtime: Runtime,
  preid: string | null,
  built: { body: string | null; change: ChangeLevel | null },
): Promise<{ version: string; body: string } | null> {
  if (config.version === CALVER_VERSION) {
    if (built.body === null) return null;
    const version = await nextCalVer(config.date, runtime.git);
    runtime.stdout(`Version ${version}: CalVer of ${config.date}.`);
    return { version, body: built.body };
  }
  const bump: Bump | null = isBump(config.version) ? config.version : null;
  const versions = await resolveVersions(config.current, runtime.git);
  const next = nextVersion({ ...versions, preid }, built.change, bump);
  if (!next) return null;
  const reason = next.promotes
    ? `stable release of ${next.promotes}`
    : `${bump ?? built.change} ${bump ? 'bump' : 'change'} since ${versions.current}`;
  runtime.stdout(`Version ${next.version}: ${reason}${preid ? ` (prerelease "${preid}")` : ''}.`);
  return {
    version: next.version,
    body: built.body ?? STABLE_RELEASE[config.locale](next.promotes!),
  };
}

/**
 * Fold the fragments, and the changes of `skipAuthors` merged since the
 * previous tag, into a new CHANGELOG.md section, and delete the fragments.
 * With `--version auto` (or a bump), the entries (or the bump) and
 * `.changelog/prerelease` give the next version; with `--version calver`,
 * the date and the tags of its month. Returns the exit code.
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

  const computed = isComputedVersion(config.version);
  // CalVer has no prereleases: like an explicit version, it ignores the file.
  const prerelease =
    computed && config.version !== CALVER_VERSION
      ? readPrerelease(runtime.cwd)
      : { id: null, errors: [] };
  if (prerelease.errors.length > 0) {
    reportIssues(runtime, prerelease.errors);
    runtime.stderr(
      `Invalid ${PRERELEASE_FILE}: CHANGELOG.md and ${FRAGMENTS_DIRECTORY}/ are unchanged.`,
    );
    return 1;
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

  const next = computed
    ? await computedRelease(config, runtime, prerelease.id, { body, change })
    : body === null
      ? null
      : { version: config.version, body };
  if (!next) {
    runtime.stdout(
      `No fragment in ${FRAGMENTS_DIRECTORY}/ and no ${platform.noun} from skip-authors: CHANGELOG.md is unchanged.`,
    );
    writeOutputs(config, runtime, computed ? '' : config.version, '');
    return 0;
  }

  const { version } = next;
  const heading = `${config.headingPrefix}${version}`;
  const section = formatSection(heading, config.date, next.body);

  const changelogPath = join(runtime.cwd, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    throw new ConfigError('CHANGELOG.md not found.', {
      hint: 'Commit a CHANGELOG.md before the first release.',
    });
  }
  writeFileSync(
    changelogPath,
    insertSection(readFileSync(changelogPath, 'utf8'), section, heading),
  );
  for (const file of used) rmSync(join(runtime.cwd, file));

  runtime.stdout(section);
  writeOutputs(config, runtime, version, next.body);
  return 0;
}
