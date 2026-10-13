import { describe, expect, it } from 'vitest';
import type { ChangeLevel } from './changelog.js';
import { tableGit } from './test-utils.js';
import { type Bump, findVersionTag, nextVersion, resolveVersions } from './version.js';

/** The next version of `current` (stable `stable`) with this prerelease file. */
function next(
  current: string,
  change: ChangeLevel | null,
  options: { stable?: string; preid?: string; bump?: Bump } = {},
) {
  const stable = options.stable ?? current;
  return nextVersion(
    { current, stable, preid: options.preid ?? null },
    change,
    options.bump ?? null,
  );
}

describe('nextVersion', () => {
  describe('with a bump', () => {
    it('replaces the bump of the entries', () => {
      expect(next('0.4.7', 'fix', { bump: 'major' })?.version).toBe('1.0.0');
      expect(next('1.4.2', 'breaking', { bump: 'patch' })?.version).toBe('1.4.3');
      expect(next('1.1.0', 'fix', { bump: 'minor', preid: 'rc' })?.version).toBe('1.2.0-rc.0');
    });

    it('releases nothing on a stable version without entries', () => {
      expect(next('1.4.2', null, { bump: 'minor' })).toBeNull();
    });

    it('promotes a prerelease to the bump of the stable version or to its base', () => {
      const rc = { stable: '1.1.0' };
      expect(next('1.2.0-rc.1', null, { ...rc, bump: 'major' })).toEqual({
        version: '2.0.0',
        promotes: '1.2.0-rc.1',
      });
      expect(next('1.2.0-rc.1', null, { ...rc, bump: 'patch' })?.version).toBe('1.2.0');
    });
  });

  describe('stable version, no prerelease file', () => {
    it('bumps major, minor or patch from 1.0.0', () => {
      expect(next('1.4.2', 'breaking')?.version).toBe('2.0.0');
      expect(next('1.4.2', 'feature')?.version).toBe('1.5.0');
      expect(next('1.4.2', 'fix')).toEqual({ version: '1.4.3', promotes: null });
    });

    it('bumps minor for a breaking change and patch otherwise on 0.x', () => {
      expect(next('0.9.9', 'breaking')?.version).toBe('0.10.0');
      expect(next('0.4.7', 'feature')?.version).toBe('0.4.8');
      expect(next('0.4.7', 'fix')?.version).toBe('0.4.8');
    });

    it('releases nothing without entries', () => {
      expect(next('1.4.2', null)).toBeNull();
    });
  });

  describe('stable version, prerelease file', () => {
    it('starts the prerelease of the bump', () => {
      expect(next('1.1.0', 'feature', { preid: 'rc' })?.version).toBe('1.2.0-rc.0');
      expect(next('1.1.0', 'breaking', { preid: 'beta' })?.version).toBe('2.0.0-beta.0');
      expect(next('1.1.0', 'fix', { preid: 'alpha' })?.version).toBe('1.1.1-alpha.0');
      expect(next('0.9.9', 'breaking', { preid: 'rc' })?.version).toBe('0.10.0-rc.0');
    });

    it('releases nothing without entries', () => {
      expect(next('1.1.0', null, { preid: 'rc' })).toBeNull();
    });
  });

  describe('prerelease, prerelease file', () => {
    const rc = { stable: '1.1.0', preid: 'rc' };

    it('bumps the prerelease number for the same identifier', () => {
      expect(next('1.2.0-rc.0', 'fix', rc)).toEqual({ version: '1.2.0-rc.1', promotes: null });
      expect(next('1.2.0-rc.1', 'feature', rc)?.version).toBe('1.2.0-rc.2');
    });

    it('starts the new identifier at 0 (beta to rc)', () => {
      expect(next('1.2.0-beta.3', 'fix', rc)?.version).toBe('1.2.0-rc.0');
      expect(next('1.2.0-0', 'fix', rc)?.version).toBe('1.2.0-rc.0');
    });

    it('moves to a higher version when the bump of the stable version is above the base', () => {
      expect(next('1.2.0-rc.1', 'breaking', rc)?.version).toBe('2.0.0-rc.0');
      expect(next('1.1.1-rc.0', 'feature', rc)?.version).toBe('1.2.0-rc.0');
      expect(next('0.10.0-rc.0', 'feature', { stable: '0.9.9', preid: 'rc' })?.version).toBe(
        '0.10.0-rc.1',
      );
    });

    it('releases nothing without entries', () => {
      expect(next('1.2.0-rc.0', null, rc)).toBeNull();
    });

    it('refuses an identifier that sorts before the current one', () => {
      expect(() => next('1.2.0-rc.2', 'fix', { stable: '1.1.0', preid: 'beta' })).toThrow(
        'The prerelease identifier "beta" gives 1.2.0-beta.0, which is not above 1.2.0-rc.2.',
      );
    });
  });

  describe('prerelease, no prerelease file', () => {
    it('promotes the prerelease without entries', () => {
      expect(next('1.2.0-rc.2', null, { stable: '1.1.0' })).toEqual({
        version: '1.2.0',
        promotes: '1.2.0-rc.2',
      });
    });

    it('keeps the base when the bump of the stable version is not above it', () => {
      expect(next('1.2.0-rc.2', 'feature', { stable: '1.1.0' })?.version).toBe('1.2.0');
      expect(next('1.2.0-rc.2', 'fix', { stable: '1.1.0' })?.version).toBe('1.2.0');
    });

    it('moves to the bump of the stable version when it is above the base', () => {
      expect(next('1.2.0-rc.2', 'breaking', { stable: '1.1.0' })).toEqual({
        version: '2.0.0',
        promotes: '1.2.0-rc.2',
      });
    });
  });

  it('refuses a version that is not semantic', () => {
    expect(() => next('2026.10', 'fix')).toThrow(
      'The current version "2026.10" is not a semantic version.',
    );
  });
});

describe('findVersionTag', () => {
  it('returns the tag with the highest version, not a moving major tag', async () => {
    const git = tableGit({ 'tag --merged HEAD': '0\n0.9.9\nv0.10.0\n0.10.0-rc.1\nlatest\n' });
    expect(await findVersionTag(git)).toBe('v0.10.0');
  });

  it('returns an empty string without a version tag', async () => {
    expect(await findVersionTag(tableGit({ 'tag --merged HEAD': '0\nlatest\n' }))).toBe('');
  });
});

describe('resolveVersions', () => {
  it('uses the given current version and the highest stable tag', async () => {
    const git = tableGit({ 'tag --merged HEAD': '1.1.0\n1.2.0-rc.0\n' });
    expect(await resolveVersions('1.2.0-rc.0', git)).toEqual({
      current: '1.2.0-rc.0',
      stable: '1.1.0',
    });
  });

  it('uses the highest version tag, with or without v, as the current version', async () => {
    const git = tableGit({ 'tag --merged HEAD': '1\nv1.10.0\n1.9.0\n1.11.0-rc.1\nlatest\n' });
    expect(await resolveVersions('', git)).toEqual({ current: '1.11.0-rc.1', stable: '1.10.0' });
  });

  it('starts from 0.0.0 without a version tag', async () => {
    expect(await resolveVersions('', tableGit({ 'tag --merged HEAD': '1\n' }))).toEqual({
      current: '0.0.0',
      stable: '0.0.0',
    });
    expect(await resolveVersions('0.1.0-rc.0', tableGit({ 'tag --merged HEAD': '' }))).toEqual({
      current: '0.1.0-rc.0',
      stable: '0.0.0',
    });
  });
});
