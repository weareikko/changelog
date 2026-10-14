import semver, { type ReleaseType, type SemVer } from 'semver';
import type { ChangeLevel } from './changelog.js';
import { ConfigError } from './errors.js';
import { listTags, type Git } from './git.js';

/** The `--version` value that computes the next version from the entries. */
export const AUTO_VERSION = 'auto';

/** The `--version` value that computes a CalVer `YYYY.M.MICRO` version. */
export const CALVER_VERSION = 'calver';

/** The `--version` values that bump the current version by a fixed level. */
export const BUMPS = ['patch', 'minor', 'major'] as const;

export type Bump = (typeof BUMPS)[number];

export function isBump(version: string): version is Bump {
  return (BUMPS as readonly string[]).includes(version);
}

/** `--version auto`, `calver` or a bump: the version comes from the tags and the entries. */
export function isComputedVersion(version: string): boolean {
  return version === AUTO_VERSION || version === CALVER_VERSION || isBump(version);
}

export interface VersionState {
  /** The version to bump: a stable version or a prerelease. */
  current: string;
  /** The latest stable version: the highest stable version tag, or 0.0.0. */
  stable: string;
  /**
   * The identifier of `.changelog/prerelease` (`alpha`, `beta`, `rc`), or
   * null without the file.
   */
  preid: string | null;
}

export interface NextVersion {
  version: string;
  /** The prerelease that this stable version promotes, if any. */
  promotes: string | null;
}

/** The version of a `1.2.0` or `v1.2.0` tag, or null for another tag (`1`, `latest`). */
function tagVersion(tag: string): string | null {
  return semver.valid(tag.replace(/^v/, ''));
}

function parse(version: string): SemVer {
  const parsed = semver.parse(version);
  if (!parsed) {
    throw new ConfigError(`The current version "${version}" is not a semantic version.`, {
      hint: 'Pass it with --current (or CHANGELOG_CURRENT_VERSION), e.g. --current 1.2.0.',
    });
  }
  return parsed;
}

/**
 * The bump of a stable version for a kind of change. From 1.0.0: breaking →
 * major, feature → minor, fix → patch. On 0.x: breaking → minor, else patch.
 */
function releaseType(version: SemVer, change: ChangeLevel): 'major' | 'minor' | 'patch' {
  if (version.major === 0) return change === 'breaking' ? 'minor' : 'patch';
  return ({ breaking: 'major', feature: 'minor', fix: 'patch' } as const)[change];
}

function inc(version: SemVer | string, type: ReleaseType, preid?: string): string {
  return new semver.SemVer(String(version)).inc(type, preid).version;
}

/**
 * The next version, or null when there is nothing to release. `change` is
 * the kind of change of the entries, or null without entries. `bump`, when
 * given, replaces the bump of {@link releaseType}.
 *
 * - Stable, no prerelease file: the bump of {@link releaseType}.
 * - Stable, prerelease file: the first prerelease of that bump (`1.1.0` →
 *   `1.2.0-rc.0`).
 * - Prerelease P with base B, prerelease file: when the bump of the stable
 *   version is above B, its first prerelease; else the first prerelease of B
 *   for a new identifier (`1.2.0-beta.3` → `1.2.0-rc.0`); else the next
 *   prerelease (`1.2.0-rc.0` → `1.2.0-rc.1`).
 * - Prerelease P with base B, no prerelease file: the stable version that
 *   promotes P: B, or the bump of the stable version when it is above B. It
 *   needs no entry.
 */
export function nextVersion(
  { current, stable, preid }: VersionState,
  change: ChangeLevel | null,
  bump: Bump | null = null,
): NextVersion | null {
  const version = parse(current);
  const base = `${version.major}.${version.minor}.${version.patch}`;
  const latest = parse(stable);
  const typeOf = (from: SemVer) => bump ?? (change ? releaseType(from, change) : null);
  const latestType = typeOf(latest);
  const target = latestType ? inc(latest, latestType) : base;

  if (version.prerelease.length === 0) {
    if (!change) return null;
    const type = typeOf(version)!;
    return {
      version: preid ? inc(version, `pre${type}`, preid) : inc(version, type),
      promotes: null,
    };
  }

  if (!preid) {
    return { version: semver.gt(target, base) ? target : base, promotes: current };
  }

  if (!change) return null;
  let next: string;
  if (semver.gt(target, base)) next = `${target}-${preid}.0`;
  else if (version.prerelease[0] !== preid) next = `${base}-${preid}.0`;
  else next = inc(version, 'prerelease', preid);

  if (!semver.gt(next, version)) {
    throw new ConfigError(
      `The prerelease identifier "${preid}" gives ${next}, which is not above ${current}.`,
      { hint: 'Use an identifier that sorts after the current one (alpha, beta, rc).' },
    );
  }
  return { version: next, promotes: null };
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
 * The current version (`current` when given, else the version of the
 * highest version tag) and the latest stable version (the highest stable
 * version tag). Both default to 0.0.0.
 */
export async function resolveVersions(
  current: string,
  git: Git,
): Promise<{ current: string; stable: string }> {
  const versions = (await listTags(git))
    .map(tagVersion)
    .filter((version): version is string => version !== null)
    .toSorted(semver.rcompare);
  const stable = versions.find((version) => semver.prerelease(version) === null) ?? '0.0.0';
  return { current: current || (versions[0] ?? '0.0.0'), stable };
}

/**
 * The CalVer version `YYYY.M.MICRO` of `date` (`YYYY-MM-DD`): MICRO is one
 * more than the highest `YYYY.M.MICRO` tag reachable from HEAD (a leading `v`
 * is allowed), or 0 for the first release of the month.
 */
export async function nextCalVer(date: string, git: Git): Promise<string> {
  const [year, month] = date.split('-').map(Number);
  const prefix = `${year}.${month}.`;
  const micros = (await listTags(git))
    .map((tag) => tag.replace(/^v/, ''))
    .filter((tag) => tag.startsWith(prefix) && /^\d+$/.test(tag.slice(prefix.length)))
    .map((tag) => Number(tag.slice(prefix.length)));
  return `${prefix}${micros.length > 0 ? Math.max(...micros) + 1 : 0}`;
}
