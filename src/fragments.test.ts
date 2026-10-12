import { describe, expect, it } from 'vitest';
import { readFragments, readPrerelease } from './fragments.js';
import { makeDirectory } from './test-utils.js';

describe('readFragments', () => {
  it('reads the Markdown fragments of .changelog/, sorted', () => {
    const cwd = makeDirectory({
      '.changelog/b.md': 'B',
      '.changelog/a.md': 'A',
      '.changelog/.gitkeep': '',
      '.changelog/notes.txt': 'x',
      '.changelog/dir.md/nested.md': 'x',
    });
    expect(readFragments(cwd)).toEqual([
      { file: '.changelog/a.md', text: 'A' },
      { file: '.changelog/b.md', text: 'B' },
    ]);
  });

  it('asks for a .changelog/ directory', () => {
    expect(() => readFragments(makeDirectory())).toThrow('No .changelog/ directory.');
  });
});

describe('readPrerelease', () => {
  it('reads the identifier of .changelog/prerelease', () => {
    expect(readPrerelease(makeDirectory({ '.changelog/prerelease': 'beta\n' }))).toEqual({
      id: 'beta',
      errors: [],
    });
  });

  it('returns no identifier without the file', () => {
    expect(readPrerelease(makeDirectory({ '.changelog/.gitkeep': '' }))).toEqual({
      id: null,
      errors: [],
    });
  });

  it('is not a fragment', () => {
    const cwd = makeDirectory({ '.changelog/prerelease': 'rc\n' });
    expect(readFragments(cwd)).toEqual([]);
  });
});
