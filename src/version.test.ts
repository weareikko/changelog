import { describe, expect, it } from 'vitest';
import { tableGit } from './test-utils.js';
import { findVersionTag, nextVersion, resolveCurrentVersion } from './version.js';

describe('nextVersion', () => {
  it('bumps major, minor or patch from 1.0.0', () => {
    expect(nextVersion('1.4.2', 'breaking')).toBe('2.0.0');
    expect(nextVersion('1.4.2', 'feature')).toBe('1.5.0');
    expect(nextVersion('1.4.2', 'fix')).toBe('1.4.3');
  });

  it('bumps minor for a breaking change and patch otherwise on 0.x', () => {
    expect(nextVersion('0.4.7', 'breaking')).toBe('0.5.0');
    expect(nextVersion('0.4.7', 'feature')).toBe('0.4.8');
    expect(nextVersion('0.4.7', 'fix')).toBe('0.4.8');
  });

  it('bumps the prerelease number of a prerelease, whatever the change', () => {
    expect(nextVersion('1.0.0-rc.1', 'breaking')).toBe('1.0.0-rc.2');
    expect(nextVersion('0.5.0-beta.0', 'feature')).toBe('0.5.0-beta.1');
  });

  it('refuses a version that is not semantic', () => {
    expect(() => nextVersion('2026.10', 'fix')).toThrow(
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

describe('resolveCurrentVersion', () => {
  it('uses the given version', async () => {
    expect(await resolveCurrentVersion('1.2.3', tableGit({}))).toBe('1.2.3');
  });

  it('uses the highest version tag reachable from HEAD, with or without v', async () => {
    const git = tableGit({ 'tag --merged HEAD': '1\nv1.10.0\n1.9.0\n1.10.0-rc.1\nlatest\n' });
    expect(await resolveCurrentVersion('', git)).toBe('1.10.0');
  });

  it('starts from 0.0.0 without a version tag', async () => {
    expect(await resolveCurrentVersion('', tableGit({ 'tag --merged HEAD': '1\n' }))).toBe('0.0.0');
    expect(await resolveCurrentVersion('', tableGit({ 'tag --merged HEAD': '' }))).toBe('0.0.0');
  });
});
