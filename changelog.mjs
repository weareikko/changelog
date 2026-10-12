// Pure changelog logic: parse fragments, build a release section, insert it
// into CHANGELOG.md. No I/O here — see cli.mjs for git and files, and
// platforms.mjs for the GitHub and GitLab APIs.

/**
 * Keep a Changelog sections by locale, in the order a release renders them.
 * The last one gets the pull requests without fragment (dependency updates).
 */
export const SECTIONS = {
  en: ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Dependencies'],
  fr: ['Ajouté', 'Modifié', 'Déprécié', 'Supprimé', 'Corrigé', 'Sécurité', 'Dépendances'],
};

const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S/;

/**
 * Parse one fragment. A fragment holds one or more `### <Section>` headings,
 * each followed by its entries, and optional link definitions. Nothing else.
 * @param {string} text
 * @param {string} file Path used in error messages.
 * @param {string[]} sections Allowed section names, e.g. `SECTIONS.en`.
 * @returns {{ sections: Map<string, string[]>, links: string[], errors: { file: string, line: number, message: string }[] }}
 */
export function parseFragment(text, file, sections) {
  const found = new Map();
  const links = [];
  const errors = [];
  let current = null;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    const lineNumber = index + 1;
    if (line.trim() === '') return;

    const heading = line.match(/^(#+)\s+(.*)$/);
    if (heading) {
      const title = heading[2].trim();
      if (heading[1] !== '###') {
        errors.push({ file, line: lineNumber, message: `Heading "${line}" is not allowed. A fragment only contains "### <Section>" headings.` });
      } else if (!sections.includes(title)) {
        errors.push({ file, line: lineNumber, message: `Unknown section "${title}". Use one of: ${sections.join(', ')}.` });
      } else {
        current = title;
        if (!found.has(title)) found.set(title, []);
      }
      return;
    }

    if (LINK_DEFINITION.test(line)) {
      links.push(line);
      return;
    }

    if (current === null) {
      errors.push({ file, line: lineNumber, message: `Line "${line}" is outside of any section. A fragment starts with a "### <Section>" heading.` });
      return;
    }

    found.get(current).push(line);
  });

  for (const [title, entries] of found) {
    if (entries.length === 0) {
      errors.push({ file, line: 1, message: `Section "${title}" has no entries.` });
    }
  }

  return { sections: found, links, errors };
}

/**
 * Append a ` [[#N]]` (GitHub) or ` [[!N]]` (GitLab) reference to each
 * top-level entry that has no pull request (`[#N]`), merge request (`[!N]`)
 * or commit (`[abc1234]`) reference yet and does not mention the reference.
 * @param {string[]} entries
 * @param {string} reference `#N` or `!N`.
 * @returns {{ entries: string[], added: boolean }}
 */
export function addReference(entries, reference) {
  const mention = new RegExp(`\\[([#!]\\d+|[0-9a-f]{7,40})\\]|${reference}(?!\\d)`);
  let added = false;
  const result = entries.map((entry) => {
    if (!entry.startsWith('- ') || mention.test(entry)) return entry;
    added = true;
    return `${entry} [[${reference}]]`;
  });
  return { entries: result, added };
}

/**
 * Turn a pull request title into a changelog entry: remove the conventional
 * commit prefix (`chore(deps): `) and upper-case the first letter.
 * @param {string} title
 */
export function titleToEntry(title) {
  const text = title.trim().replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
  return `- ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Build the release section from parsed fragments and pull requests without
 * fragment (e.g. dependency updates from a bot).
 * @param {object} options
 * @param {string} options.version
 * @param {string} options.date
 * @param {string[]} options.sections Section names, e.g. `SECTIONS.en`.
 * @param {{ prefix: string, url: (number: number) => string }} options.references
 *   How to write a pull request reference: `#` and `<repository>/pull/N` on
 *   GitHub, `!` and `<project>/-/merge_requests/N` on GitLab.
 * @param {{ file: string, text: string, pr?: number | null }[]} options.fragments
 *   Fragments in the order their entries should appear.
 * @param {{ number: number, title: string }[]} [options.pulls] Each pull
 *   request becomes an entry of the last section (`Dependencies`), after the
 *   fragment entries, unless a fragment came from the same pull request.
 * @returns {{ section: string | null, body: string, used: string[], errors: { file: string, line: number, message: string }[] }}
 *   `section` is null when there is no entry. `used` lists the fragments that went into it.
 */
export function buildRelease({ version, date, sections, references, fragments, pulls = [] }) {
  const merged = new Map(sections.map((title) => [title, []]));
  const prs = new Set();
  const links = [];
  const used = [];
  const errors = [];

  for (const fragment of fragments) {
    const parsed = parseFragment(fragment.text, fragment.file, sections);
    errors.push(...parsed.errors);
    if (parsed.errors.length > 0 || parsed.sections.size === 0) continue;

    used.push(fragment.file);
    for (const [title, entries] of parsed.sections) {
      if (!fragment.pr) {
        merged.get(title).push(...entries);
        continue;
      }
      const referenced = addReference(entries, `${references.prefix}${fragment.pr}`);
      merged.get(title).push(...referenced.entries);
      if (referenced.added) prs.add(fragment.pr);
    }
    links.push(...parsed.links);
  }

  const credited = new Set(fragments.map((fragment) => fragment.pr).filter(Boolean));
  const dependencies = merged.get(sections.at(-1));
  for (const pull of pulls) {
    if (credited.has(pull.number)) continue;
    dependencies.push(`${titleToEntry(pull.title)} [[${references.prefix}${pull.number}]]`);
    prs.add(pull.number);
  }

  if (errors.length > 0 || [...merged.values()].every((entries) => entries.length === 0)) {
    return { section: null, body: '', used: [], errors };
  }

  const blocks = [];
  for (const [title, entries] of merged) {
    if (entries.length > 0) blocks.push(`### ${title}\n\n${entries.join('\n')}`);
  }

  // Pull request definitions first, by number (generated or written in a fragment),
  // then the other definitions in the order they appear.
  const pullNumber = (line) => Number(line.match(/^\[[#!](\d+)\]:/)?.[1] ?? Number.NaN);
  const definitions = [
    ...[...prs].map((pr) => `[${references.prefix}${pr}]: ${references.url(pr)}`),
    ...links,
  ]
    .filter((line, index, all) => all.indexOf(line) === index)
    .map((line, index) => ({ line, index, pr: pullNumber(line) }))
    .sort((a, b) => {
      if (Number.isNaN(a.pr) || Number.isNaN(b.pr)) {
        return Number.isNaN(a.pr) - Number.isNaN(b.pr) || a.index - b.index;
      }
      return a.pr - b.pr;
    })
    .map(({ line }) => line);
  if (definitions.length > 0) blocks.push(definitions.join('\n'));

  const body = blocks.join('\n\n');
  return { section: `## ${version} - ${date}\n\n${body}`, body, used, errors };
}

/**
 * Insert a release section before the first `## ` heading of the changelog,
 * or at its end when it has none.
 * @param {string} changelog
 * @param {string} section
 * @param {string} version
 */
export function insertSection(changelog, section, version) {
  const lines = changelog.split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (lines.some((line) => new RegExp(`^## ${escaped}( |$)`).test(line))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  }

  const index = lines.findIndex((line) => line.startsWith('## '));
  if (index === -1) {
    return `${changelog.trimEnd()}\n\n${section}\n`;
  }
  lines.splice(index, 0, ...section.split('\n'), '');
  return lines.join('\n');
}
