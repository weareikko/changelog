// Pure changelog logic: parse fragments, build a release section, insert it
// into CHANGELOG.md. No I/O here — see cli.mjs for git, GitHub and files.

/** Keep a Changelog sections, in the order a release renders them. */
export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Dependencies'];

const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S/;

/**
 * Parse one fragment. A fragment holds one or more `### <Section>` headings,
 * each followed by its entries, and optional link definitions. Nothing else.
 * @param {string} text
 * @param {string} file Path used in error messages.
 * @returns {{ sections: Map<string, string[]>, links: string[], errors: { file: string, line: number, message: string }[] }}
 */
export function parseFragment(text, file) {
  const sections = new Map();
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
      } else if (!SECTIONS.includes(title)) {
        errors.push({ file, line: lineNumber, message: `Unknown section "${title}". Use one of: ${SECTIONS.join(', ')}.` });
      } else {
        current = title;
        if (!sections.has(title)) sections.set(title, []);
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

    sections.get(current).push(line);
  });

  for (const [title, entries] of sections) {
    if (entries.length === 0) {
      errors.push({ file, line: 1, message: `Section "${title}" has no entries.` });
    }
  }

  return { sections, links, errors };
}

/**
 * Append a ` [[#N]]` reference to each top-level entry that does not already
 * mention the pull request.
 * @param {string[]} entries
 * @param {number} pr
 */
export function addReference(entries, pr) {
  const mention = new RegExp(`#${pr}(?!\\d)`);
  return entries.map((entry) =>
    entry.startsWith('- ') && !mention.test(entry) ? `${entry} [[#${pr}]]` : entry,
  );
}

/**
 * Build the release section from parsed fragments.
 * @param {{ version: string, date: string, repositoryUrl: string, fragments: { file: string, text: string, pr?: number | null }[] }} options
 *   Fragments in the order their entries should appear.
 * @returns {{ section: string | null, body: string, used: string[], errors: { file: string, line: number, message: string }[] }}
 *   `section` is null when no fragment has entries. `used` lists the fragments that went into it.
 */
export function buildRelease({ version, date, repositoryUrl, fragments }) {
  const merged = new Map(SECTIONS.map((title) => [title, []]));
  const prs = new Set();
  const links = [];
  const used = [];
  const errors = [];

  for (const fragment of fragments) {
    const parsed = parseFragment(fragment.text, fragment.file);
    errors.push(...parsed.errors);
    if (parsed.errors.length > 0 || parsed.sections.size === 0) continue;

    used.push(fragment.file);
    for (const [title, entries] of parsed.sections) {
      merged.get(title).push(...(fragment.pr ? addReference(entries, fragment.pr) : entries));
    }
    if (fragment.pr) prs.add(fragment.pr);
    links.push(...parsed.links);
  }

  if (errors.length > 0 || used.length === 0) {
    return { section: null, body: '', used: [], errors };
  }

  const blocks = [];
  for (const [title, entries] of merged) {
    if (entries.length > 0) blocks.push(`### ${title}\n\n${entries.join('\n')}`);
  }

  const definitions = [
    ...[...prs].sort((a, b) => a - b).map((pr) => `[#${pr}]: ${repositoryUrl}/pull/${pr}`),
    ...links,
  ].filter((line, index, all) => all.indexOf(line) === index);
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
