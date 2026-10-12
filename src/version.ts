import semver from 'semver';
import type { ChangeLevel } from './changelog.js';
import { ConfigError } from './errors.js';
import { listTags, type Git } from './git.js';

/** The `--version` value that computes the next version from the entries. */
export const AUTO_VERSION = 'auto';

/**
 * The version after `current` for a release of this kind of change. From
 * 1.0.0: breaking → major, feature → minor, fix → patch. On 0.x: breaking →
 * minor, else patch. A prerelease gets the next prerelease with the same
 * identifier (1.0.0-rc.1 → 1.0.0-rc.2).
 */
export function nextVersion(current: string, change: ChangeLevel): string {
  const version = semver.parse(current);
  if (!version) {
    throw new ConfigError(`The current version "${current}" is not a semantic version.`, {
      hint: 'Pass it with --current (or CHANGELOG_CURRENT_VERSION), e.g. --current 1.2.0.',
    });
  }
  if (version.prerelease.length > 0) return version.inc('prerelease').version;
  if (version.major === 0) return version.inc(change === 'breaking' ? 'minor' : 'patch').version;
  const release = { breaking: 'major', feature: 'minor', fix: 'patch' } as const;
  return version.inc(release[change]).version;
}

/** The version of a `1.2.0` or `v1.2.0` tag, or null for another tag (`1`, `latest`). */
function tagVersion(tag: string): string | null {
  return semver.valid(tag.replace(/^v/, ''));
}

/**
 * The previous release: the tag reachable from HEAD with the highest semantic
 * version (a leading `v` is allowed), or an empty string. A moving major tag
 * (`1`) or any other tag does not count.
 */
export async function findVersionTag(git: Git): Promise<string> {
  const tags = (await listTags(git)).filter((tag) => tagVersion(tag) !== null);
  return tags.toSorted((a, b) => semver.rcompare(tagVersion(a)!, tagVersion(b)!))[0] ?? '';
}

/**
 * The current version: `current` when given, else the version of
 * {@link findVersionTag}, else 0.0.0.
 */
export async function resolveCurrentVersion(current: string, git: Git): Promise<string> {
  if (current) return current;
  const tag = await findVersionTag(git);
  return tag ? tagVersion(tag)! : '0.0.0';
}
