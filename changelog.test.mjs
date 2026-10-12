import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addReference, buildRelease, insertSection, parseFragment } from './changelog.mjs';

describe('parseFragment', () => {
  it('groups entries and link definitions by section', () => {
    const { sections, links, errors } = parseFragment(
      '### Added\n\n- One\n- Two\n  continued\n\n### Fixed  \n- Three\n\n[abc1234]: https://example.com/abc1234\n',
      'a.md',
    );
    assert.deepEqual(errors, []);
    assert.deepEqual([...sections], [
      ['Added', ['- One', '- Two', '  continued']],
      ['Fixed', ['- Three']],
    ]);
    assert.deepEqual(links, ['[abc1234]: https://example.com/abc1234']);
  });

  it('merges repeated sections', () => {
    const { sections } = parseFragment('### Added\n- One\n### Added\n- Two\n', 'a.md');
    assert.deepEqual(sections.get('Added'), ['- One', '- Two']);
  });

  it('accepts CRLF line endings', () => {
    const { sections, errors } = parseFragment('### Added\r\n- One\r\n', 'a.md');
    assert.deepEqual(errors, []);
    assert.deepEqual(sections.get('Added'), ['- One']);
  });

  it('rejects headings other than ###', () => {
    const { errors } = parseFragment('## 1.0.0\n### Added\n- One\n#### Detail\n', 'a.md');
    assert.deepEqual(errors.map((error) => error.line), [1, 4]);
    assert.match(errors[0].message, /not allowed/);
  });

  it('rejects unknown sections', () => {
    const { errors } = parseFragment('### Add\n- One\n', 'a.md');
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /Unknown section "Add"/);
    assert.match(errors[1].message, /outside of any section/);
  });

  it('rejects lines before the first section', () => {
    const { errors } = parseFragment('- One\n### Added\n- Two\n', 'b.md');
    assert.deepEqual(errors, [
      { file: 'b.md', line: 1, message: 'Line "- One" is outside of any section. A fragment starts with a "### <Section>" heading.' },
    ]);
  });

  it('rejects empty sections', () => {
    const { errors } = parseFragment('### Added\n\n### Fixed\n- One\n', 'a.md');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /"Added" has no entries/);
  });
});

describe('addReference', () => {
  it('appends the reference to top-level entries only', () => {
    assert.deepEqual(addReference(['- One', '  continued', '  - nested'], 12), {
      entries: ['- One [[#12]]', '  continued', '  - nested'],
      added: true,
    });
  });

  it('keeps entries that mention the pull request or already have a reference', () => {
    assert.deepEqual(addReference(['- One (#12)', '- Two [[#123], [abc1234]]', '- Fix #120 crash'], 12), {
      entries: ['- One (#12)', '- Two [[#123], [abc1234]]', '- Fix #120 crash [[#12]]'],
      added: true,
    });
    assert.deepEqual(addReference(['- Two [[#123]]'], 12), { entries: ['- Two [[#123]]'], added: false });
    assert.deepEqual(addReference(['- Three [[915f084]]', '- Four [[915f084], [#3]]', '- Five [link]'], 12), {
      entries: ['- Three [[915f084]]', '- Four [[915f084], [#3]]', '- Five [link] [[#12]]'],
      added: true,
    });
  });
});

describe('buildRelease', () => {
  const base = { version: '1.2.0', date: '2026-10-12', repositoryUrl: 'https://github.com/acme/repo' };

  it('merges fragments in section order and adds pull request links', () => {
    const result = buildRelease({
      ...base,
      fragments: [
        { file: '.changelog/b.md', text: '### Fixed\n- Fix b\n', pr: 12 },
        { file: '.changelog/a.md', text: '### Added\n- Add a\n\n[x]: https://x.test\n', pr: 3 },
        { file: '.changelog/c.md', text: '### Fixed\n- Fix c\n', pr: null },
      ],
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.used, ['.changelog/b.md', '.changelog/a.md', '.changelog/c.md']);
    assert.equal(
      result.section,
      [
        '## 1.2.0 - 2026-10-12',
        '',
        '### Added',
        '',
        '- Add a [[#3]]',
        '',
        '### Fixed',
        '',
        '- Fix b [[#12]]',
        '- Fix c',
        '',
        '[#3]: https://github.com/acme/repo/pull/3',
        '[#12]: https://github.com/acme/repo/pull/12',
        '[x]: https://x.test',
      ].join('\n'),
    );
    assert.equal(result.body, result.section.split('\n').slice(2).join('\n'));
  });

  it('adds no link definition when every entry already has a reference', () => {
    const result = buildRelease({
      ...base,
      fragments: [{ file: 'a.md', text: '### Added\n- A [[#127]]\n\n[#127]: https://github.com/acme/repo/pull/127\n', pr: 130 }],
    });
    assert.equal(result.body, '### Added\n\n- A [[#127]]\n\n[#127]: https://github.com/acme/repo/pull/127');
  });

  it('sorts pull request definitions by number, before other definitions', () => {
    const result = buildRelease({
      ...base,
      fragments: [
        { file: 'a.md', text: '### Added\n- A\n\n[x]: https://x.test\n', pr: 129 },
        { file: 'b.md', text: '### Added\n- B [[#127]]\n\n[#127]: https://github.com/acme/repo/pull/127\n[abc1234]: https://c.test\n', pr: 128 },
      ],
    });
    assert.equal(
      result.body.split('\n\n').at(-1),
      ['[#127]: https://github.com/acme/repo/pull/127', '[#129]: https://github.com/acme/repo/pull/129', '[x]: https://x.test', '[abc1234]: https://c.test'].join('\n'),
    );
  });

  it('deduplicates link definitions', () => {
    const result = buildRelease({
      ...base,
      fragments: [
        { file: 'a.md', text: '### Added\n- A\n[x]: https://x.test\n', pr: 1 },
        { file: 'b.md', text: '### Added\n- B\n[x]: https://x.test\n', pr: 1 },
      ],
    });
    assert.equal(result.body, '### Added\n\n- A [[#1]]\n- B [[#1]]\n\n[#1]: https://github.com/acme/repo/pull/1\n[x]: https://x.test');
  });

  it('returns no section when fragments are empty', () => {
    const result = buildRelease({ ...base, fragments: [{ file: 'a.md', text: '\n\n', pr: 1 }] });
    assert.equal(result.section, null);
    assert.deepEqual(result.used, []);
  });

  it('returns errors and no section when a fragment is invalid', () => {
    const result = buildRelease({
      ...base,
      fragments: [
        { file: 'a.md', text: '### Added\n- A\n' },
        { file: 'b.md', text: '## Oops\n' },
      ],
    });
    assert.equal(result.section, null);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, 'b.md');
  });
});

describe('insertSection', () => {
  const header = '# Changelog\n\nIntro.\n';

  it('inserts before the latest release', () => {
    const changelog = `${header}\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- First\n`;
    assert.equal(
      insertSection(changelog, '## 1.1.0 - 2026-02-01\n\n### Fixed\n\n- Fix', '1.1.0'),
      `${header}\n## 1.1.0 - 2026-02-01\n\n### Fixed\n\n- Fix\n\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- First\n`,
    );
  });

  it('appends to a changelog without releases', () => {
    assert.equal(insertSection(header, '## 1.0.0 - 2026-01-01\n\n### Added\n\n- First', '1.0.0'), `${header}\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- First\n`);
  });

  it('refuses a version that already exists', () => {
    assert.throws(() => insertSection(`${header}\n## 1.0.0 - 2026-01-01\n`, '## 1.0.0 - x', '1.0.0'), /already has a section for 1.0.0/);
    assert.doesNotThrow(() => insertSection(`${header}\n## 1.0.0 - 2026-01-01\n`, '## 1.0 - x', '1.0'));
  });
});
