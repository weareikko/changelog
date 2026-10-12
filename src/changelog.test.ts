import { assert, describe, it } from 'vitest';
import {
  addReference,
  buildRelease,
  changeLevel,
  formatSection,
  insertSection,
  isBreakingEntry,
  isFragmentPath,
  parseFragment,
  parsePrerelease,
  SECTIONS,
  titleToEntry,
} from './changelog.js';

describe('parseFragment', () => {
  it('groups entries and link definitions by section', () => {
    const { sections, links, errors } = parseFragment(
      '### Added\n\n- One\n- Two\n  continued\n\n### Fixed  \n- Three\n\n[abc1234]: https://example.com/abc1234\n',
      'a.md',
      SECTIONS.en,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      [...sections],
      [
        ['Added', ['- One', '- Two', '  continued']],
        ['Fixed', ['- Three']],
      ],
    );
    assert.deepEqual(links, ['[abc1234]: https://example.com/abc1234']);
  });

  it('merges repeated sections', () => {
    const { sections } = parseFragment('### Added\n- One\n### Added\n- Two\n', 'a.md', SECTIONS.en);
    assert.deepEqual(sections.get('Added'), ['- One', '- Two']);
  });

  it('accepts CRLF line endings', () => {
    const { sections, errors } = parseFragment('### Added\r\n- One\r\n', 'a.md', SECTIONS.en);
    assert.deepEqual(errors, []);
    assert.deepEqual(sections.get('Added'), ['- One']);
  });

  it('rejects headings other than ###', () => {
    const { errors } = parseFragment(
      '## 1.0.0\n### Added\n- One\n#### Detail\n',
      'a.md',
      SECTIONS.en,
    );
    assert.deepEqual(
      errors.map((error) => error.line),
      [1, 4],
    );
    assert.match(errors[0].message, /not allowed/);
  });

  it('rejects unknown sections', () => {
    const { errors } = parseFragment('### Add\n- One\n', 'a.md', SECTIONS.en);
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /Unknown section "Add"/);
    assert.match(errors[1].message, /outside of any section/);
  });

  it('rejects lines before the first section', () => {
    const { errors } = parseFragment('- One\n### Added\n- Two\n', 'b.md', SECTIONS.en);
    assert.deepEqual(errors, [
      {
        file: 'b.md',
        line: 1,
        message:
          'Line "- One" is outside of any section. A fragment starts with a "### <Section>" heading.',
      },
    ]);
  });

  it('rejects empty sections', () => {
    const { errors } = parseFragment('### Added\n\n### Fixed\n- One\n', 'a.md', SECTIONS.en);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /"Added" has no entries/);
  });

  it('uses the sections of the given locale', () => {
    const french = parseFragment(
      '### Ajouté\n- Un\n### Dépendances\n- Deux\n',
      'a.md',
      SECTIONS.fr,
    );
    assert.deepEqual(french.errors, []);
    assert.deepEqual([...french.sections.keys()], ['Ajouté', 'Dépendances']);

    const { errors } = parseFragment('### Added\n', 'a.md', SECTIONS.fr);
    assert.equal(
      errors[0].message,
      'Unknown section "Added". Use one of: Ajouté, Modifié, Déprécié, Supprimé, Corrigé, Sécurité, Dépendances.',
    );
  });
});

describe('SECTIONS', () => {
  it('has the same order in every locale, with the dependencies last', () => {
    assert.deepEqual(Object.keys(SECTIONS), ['en', 'fr']);
    assert.equal(SECTIONS.en.length, SECTIONS.fr.length);
    assert.equal(SECTIONS.en.at(-1), 'Dependencies');
    assert.equal(SECTIONS.fr.at(-1), 'Dépendances');
  });
});

describe('addReference', () => {
  it('appends the reference to top-level entries only', () => {
    assert.deepEqual(addReference(['- One', '  continued', '  - nested'], '#12'), {
      entries: ['- One ([#12])', '  continued', '  - nested'],
      added: true,
    });
  });

  it('keeps entries that mention the pull request or already have a reference', () => {
    assert.deepEqual(
      addReference(['- One (#12)', '- Two [[#123], [abc1234]]', '- Fix #120 crash'], '#12'),
      {
        entries: ['- One (#12)', '- Two [[#123], [abc1234]]', '- Fix #120 crash ([#12])'],
        added: true,
      },
    );
    assert.deepEqual(addReference(['- Two ([#123])'], '#12'), {
      entries: ['- Two ([#123])'],
      added: false,
    });
    assert.deepEqual(
      addReference(['- Three [[915f084]]', '- Four [[915f084], [#3]]', '- Five [link]'], '#12'),
      {
        entries: ['- Three [[915f084]]', '- Four [[915f084], [#3]]', '- Five [link] ([#12])'],
        added: true,
      },
    );
  });

  it('writes merge request references and keeps the ones of both platforms', () => {
    assert.deepEqual(
      addReference(
        ['- One', '- Two ([!3])', '- Three ([#4])', '- Four (!12)', '- Five !120'],
        '!12',
      ),
      {
        entries: [
          '- One ([!12])',
          '- Two ([!3])',
          '- Three ([#4])',
          '- Four (!12)',
          '- Five !120 ([!12])',
        ],
        added: true,
      },
    );
  });
});

describe('titleToEntry', () => {
  it('removes a conventional commit prefix and upper-cases the first letter', () => {
    assert.equal(
      titleToEntry('chore(deps): update dependency vitest to v4'),
      '- Update dependency vitest to v4',
    );
    assert.equal(titleToEntry('fix!: drop node 18'), '- Drop node 18');
    assert.equal(
      titleToEntry('Update actions/checkout action to v5 '),
      '- Update actions/checkout action to v5',
    );
    assert.equal(titleToEntry('update dependency: x'), '- Update dependency: x');
  });
});

describe('buildRelease', () => {
  const base = {
    sections: SECTIONS.en,
    references: {
      prefix: '#' as const,
      url: (number: number) => `https://github.com/acme/repo/pull/${number}`,
    },
  };

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
    assert.equal(result.change, 'feature');
    assert.equal(
      result.body,
      [
        '### Added',
        '',
        '- Add a ([#3])',
        '',
        '### Fixed',
        '',
        '- Fix b ([#12])',
        '- Fix c',
        '',
        '[#3]: https://github.com/acme/repo/pull/3',
        '[#12]: https://github.com/acme/repo/pull/12',
        '[x]: https://x.test',
      ].join('\n'),
    );
  });

  it('adds no link definition when every entry already has a reference', () => {
    const result = buildRelease({
      ...base,
      fragments: [
        {
          file: 'a.md',
          text: '### Added\n- A ([#127])\n\n[#127]: https://github.com/acme/repo/pull/127\n',
          pr: 130,
        },
      ],
    });
    assert.equal(
      result.body,
      '### Added\n\n- A ([#127])\n\n[#127]: https://github.com/acme/repo/pull/127',
    );
  });

  it('sorts pull request definitions by number, before other definitions', () => {
    const result = buildRelease({
      ...base,
      fragments: [
        { file: 'a.md', text: '### Added\n- A\n\n[x]: https://x.test\n', pr: 129 },
        {
          file: 'b.md',
          text: '### Added\n- B ([#127])\n\n[#127]: https://github.com/acme/repo/pull/127\n[abc1234]: https://c.test\n',
          pr: 128,
        },
      ],
    });
    assert.equal(
      result.body!.split('\n\n').at(-1),
      [
        '[#127]: https://github.com/acme/repo/pull/127',
        '[#129]: https://github.com/acme/repo/pull/129',
        '[x]: https://x.test',
        '[abc1234]: https://c.test',
      ].join('\n'),
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
    assert.equal(
      result.body,
      '### Added\n\n- A ([#1])\n- B ([#1])\n\n[#1]: https://github.com/acme/repo/pull/1\n[x]: https://x.test',
    );
  });

  it('adds pull requests under Dependencies, after the fragment entries', () => {
    const result = buildRelease({
      ...base,
      fragments: [{ file: 'a.md', text: '### Dependencies\n- Update by hand\n', pr: 9 }],
      pulls: [
        { number: 12, title: 'chore(deps): update dependency x to v2' },
        { number: 9, title: 'chore(deps): already credited by a fragment' },
        { number: 4, title: 'Update dependency y to v3' },
      ],
    });
    assert.deepEqual(result.used, ['a.md']);
    assert.equal(
      result.body,
      [
        '### Dependencies',
        '',
        '- Update by hand ([#9])',
        '- Update dependency x to v2 ([#12])',
        '- Update dependency y to v3 ([#4])',
        '',
        '[#4]: https://github.com/acme/repo/pull/4',
        '[#9]: https://github.com/acme/repo/pull/9',
        '[#12]: https://github.com/acme/repo/pull/12',
      ].join('\n'),
    );
  });

  it('builds a section from pull requests alone', () => {
    const result = buildRelease({
      ...base,
      fragments: [],
      pulls: [{ number: 5, title: 'chore(deps): update x' }],
    });
    assert.deepEqual(result.used, []);
    assert.equal(result.change, 'fix');
    assert.equal(
      result.body,
      '### Dependencies\n\n- Update x ([#5])\n\n[#5]: https://github.com/acme/repo/pull/5',
    );
  });

  it('writes GitLab references and French sections', () => {
    const result = buildRelease({
      ...base,
      sections: SECTIONS.fr,
      references: {
        prefix: '!' as const,
        url: (number: number) => `https://gitlab.test/acme/repo/-/merge_requests/${number}`,
      },
      fragments: [
        { file: 'a.md', text: '### Corrigé\n- Corrige a\n### Dépendances\n- À la main\n', pr: 12 },
        {
          file: 'b.md',
          text: '### Ajouté\n- Ancien ([!3])\n\n[!3]: https://gitlab.test/acme/repo/-/merge_requests/3\n',
          pr: 13,
        },
      ],
      pulls: [{ number: 4, title: 'chore(deps): update x' }],
    });
    assert.equal(
      result.body,
      [
        '### Ajouté',
        '',
        '- Ancien ([!3])',
        '',
        '### Corrigé',
        '',
        '- Corrige a ([!12])',
        '',
        '### Dépendances',
        '',
        '- À la main ([!12])',
        '- Update x ([!4])',
        '',
        '[!3]: https://gitlab.test/acme/repo/-/merge_requests/3',
        '[!4]: https://gitlab.test/acme/repo/-/merge_requests/4',
        '[!12]: https://gitlab.test/acme/repo/-/merge_requests/12',
      ].join('\n'),
    );
  });

  it('returns no body when fragments are empty', () => {
    const result = buildRelease({ ...base, fragments: [{ file: 'a.md', text: '\n\n', pr: 1 }] });
    assert.equal(result.body, null);
    assert.equal(result.change, null);
    assert.deepEqual(result.used, []);
  });

  it('returns errors and no body when a fragment is invalid', () => {
    const result = buildRelease({
      ...base,
      fragments: [
        { file: 'a.md', text: '### Added\n- A\n' },
        { file: 'b.md', text: '## Oops\n' },
      ],
      pulls: [{ number: 5, title: 'Update x' }],
    });
    assert.equal(result.body, null);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, 'b.md');
  });
});

describe('parsePrerelease', () => {
  const file = '.changelog/prerelease';

  it('reads one identifier, with or without a final newline', () => {
    for (const text of ['rc', 'rc\n', 'rc\r\n\n', ' beta-2 \n', 'alpha1']) {
      assert.deepEqual(parsePrerelease(text, file).errors, [], text);
    }
    assert.equal(parsePrerelease(' beta-2 \n', file).id, 'beta-2');
  });

  it('rejects an empty file, several lines and invalid identifiers', () => {
    assert.deepEqual(parsePrerelease('\n', file), {
      id: null,
      errors: [
        {
          file,
          line: 1,
          message:
            'The prerelease file is empty. Write the prerelease identifier (alpha, beta, rc).',
        },
      ],
    });
    assert.equal(parsePrerelease('rc\nbeta\n', file).errors[0].line, 2);
    for (const text of ['12', 'rc.1', 'release candidate', 'bêta']) {
      assert.match(
        parsePrerelease(text, file).errors[0].message,
        /is not a valid prerelease identifier/,
        text,
      );
    }
  });
});

describe('isBreakingEntry', () => {
  it('accepts the three markers, after an optional package prefix', () => {
    for (const entry of [
      '- Breaking: drop Node.js 22',
      '- **Breaking:** drop Node.js 22',
      '- ⚠️ drop Node.js 22',
      '- ⚠ drop Node.js 22',
      '- **CLI**: Breaking: rename --foo',
      '- **CLI:** **Breaking:** rename --foo',
      '- **@scope/pkg:** ⚠️ rename --foo',
      '- **BREAKING**: Remove the `sse` MCP transport',
      '- breaking: lower case',
      '- **MCP**: **Breaking**: remove `sse`',
    ]) {
      assert.isTrue(isBreakingEntry(entry), entry);
    }
  });

  it('rejects other entries', () => {
    for (const entry of [
      '- Add a breaking change detector',
      '- Breaking change without colon',
      '- **Breaking** without colon',
      '  - Breaking: a sub-entry',
      '- **CLI**: Add Breaking: in the middle',
      'Breaking: not an entry',
    ]) {
      assert.isFalse(isBreakingEntry(entry), entry);
    }
  });
});

describe('changeLevel', () => {
  const sections = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

  it('is breaking when any entry is breaking', () => {
    assert.equal(
      changeLevel(sections({ Added: ['- A'], Fixed: ['- Breaking: B'] }), 'Added'),
      'breaking',
    );
  });

  it('is a feature with an entry in the given Added section, else a fix', () => {
    assert.equal(changeLevel(sections({ Ajouté: ['- A'], Corrigé: [] }), 'Ajouté'), 'feature');
    assert.equal(changeLevel(sections({ Ajouté: [], Corrigé: ['- B'] }), 'Ajouté'), 'fix');
    assert.equal(changeLevel(sections({ Dependencies: ['- C'] }), 'Added'), 'fix');
  });

  it('gives buildRelease the level of French fragments', () => {
    const result = buildRelease({
      sections: SECTIONS.fr,
      references: {
        prefix: '!',
        url: (number) => `https://gitlab.test/-/merge_requests/${number}`,
      },
      fragments: [{ file: 'a.md', text: '### Ajouté\n- Nouveau\n' }],
    });
    assert.equal(result.change, 'feature');
  });
});

describe('formatSection', () => {
  it('adds the version heading', () => {
    assert.equal(
      formatSection('1.2.0', '2026-10-12', '### Fixed\n\n- Fix'),
      '## 1.2.0 - 2026-10-12\n\n### Fixed\n\n- Fix',
    );
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
    assert.equal(
      insertSection(header, '## 1.0.0 - 2026-01-01\n\n### Added\n\n- First', '1.0.0'),
      `${header}\n## 1.0.0 - 2026-01-01\n\n### Added\n\n- First\n`,
    );
  });

  it('refuses a version that already exists', () => {
    assert.throws(
      () => insertSection(`${header}\n## 1.0.0 - 2026-01-01\n`, '## 1.0.0 - x', '1.0.0'),
      /already has a section for 1.0.0/,
    );
    assert.doesNotThrow(() =>
      insertSection(`${header}\n## 1.0.0 - 2026-01-01\n`, '## 1.0 - x', '1.0'),
    );
  });
});

describe('isFragmentPath', () => {
  it('accepts Markdown files directly in .changelog/ only', () => {
    assert.isTrue(isFragmentPath('.changelog/ssh-sync.md'));
    assert.isFalse(isFragmentPath('.changelog/.gitkeep'));
    assert.isFalse(isFragmentPath('.changelog/.hidden.md'));
    assert.isFalse(isFragmentPath('.changelog/sub/a.md'));
    assert.isFalse(isFragmentPath('.changelog/a.txt'));
    assert.isFalse(isFragmentPath('docs/a.md'));
  });
});
