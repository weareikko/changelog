// Pure changelog logic: parse fragments, build a release section, insert it
// into CHANGELOG.md. No I/O here: see check.ts and release.ts.

/** The directory that holds the fragments. */
export const FRAGMENTS_DIRECTORY = '.changelog';

/**
 * Keep a Changelog sections by locale, in the order a release renders them.
 * The last one gets the pull requests without fragment (dependency updates).
 * The French names are the ones of the `release` job of studiometa/gitlab-ci.
 */
export const SECTIONS = {
  en: ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Dependencies'],
  fr: ['Ajouté', 'Modifié', 'Déprécié', 'Supprimé', 'Corrigé', 'Sécurité', 'Dépendances'],
} as const satisfies Record<string, readonly string[]>;

export type Locale = keyof typeof SECTIONS;

export const LOCALES = Object.keys(SECTIONS) as Locale[];

/** A problem in a file, with its 1-based line. */
export interface FileIssue {
  file: string;
  line: number;
  message: string;
}

export interface ParsedFragment {
  sections: Map<string, string[]>;
  links: string[];
  errors: FileIssue[];
}

/** How to write a pull request (`#N`) or merge request (`!N`) reference. */
export interface References {
  prefix: '#' | '!';
  url: (number: number) => string;
}

export interface ReleaseFragment {
  file: string;
  text: string;
  /** The pull or merge request that added the fragment, when known. */
  pr?: number | null;
}

export interface ReleasePull {
  number: number;
  title: string;
}

export interface BuildReleaseOptions {
  version: string;
  date: string;
  sections: readonly string[];
  references: References;
  /** Fragments in the order their entries should appear. */
  fragments: ReleaseFragment[];
  /**
   * Pull requests without fragment (e.g. dependency updates from a bot). Each
   * one becomes an entry of the last section, after the fragment entries,
   * unless a fragment came from the same pull request.
   */
  pulls?: ReleasePull[];
}

export interface BuiltRelease {
  /** The `## <version> - <date>` section, or null when there is no entry. */
  section: string | null;
  /** The section without its heading, e.g. for release notes. */
  body: string;
  /** The fragments that went into the section. */
  used: string[];
  errors: FileIssue[];
}

const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S/;

/**
 * Parse one fragment. A fragment holds one or more `### <Section>` headings,
 * each followed by its entries, and optional link definitions. Nothing else.
 */
export function parseFragment(
  text: string,
  file: string,
  sections: readonly string[],
): ParsedFragment {
  const found = new Map<string, string[]>();
  const links: string[] = [];
  const errors: FileIssue[] = [];
  let current: string[] | null = null;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    const lineNumber = index + 1;
    if (line.trim() === '') return;

    const heading = /^(#+)\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[2].trim();
      if (heading[1] !== '###') {
        errors.push({
          file,
          line: lineNumber,
          message: `Heading "${line}" is not allowed. A fragment only contains "### <Section>" headings.`,
        });
      } else if (!sections.includes(title)) {
        errors.push({
          file,
          line: lineNumber,
          message: `Unknown section "${title}". Use one of: ${sections.join(', ')}.`,
        });
      } else {
        current = found.get(title) ?? [];
        found.set(title, current);
      }
      return;
    }

    if (LINK_DEFINITION.test(line)) {
      links.push(line);
      return;
    }

    if (current === null) {
      errors.push({
        file,
        line: lineNumber,
        message: `Line "${line}" is outside of any section. A fragment starts with a "### <Section>" heading.`,
      });
      return;
    }

    current.push(line);
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
 */
export function addReference(
  entries: string[],
  reference: string,
): { entries: string[]; added: boolean } {
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
 */
export function titleToEntry(title: string): string {
  const text = title.trim().replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
  return `- ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The number of a `[#N]: …` or `[!N]: …` definition, or NaN. */
function pullNumber(line: string): number {
  return Number(/^\[[#!](\d+)\]:/.exec(line)?.[1] ?? Number.NaN);
}

/** Pull request definitions first, by number, then the others in their order. */
function sortDefinitions(definitions: string[]): string[] {
  return [...new Set(definitions)]
    .map((line, index) => ({ line, index, pr: pullNumber(line) }))
    .toSorted((a, b) => {
      if (Number.isNaN(a.pr) || Number.isNaN(b.pr)) {
        return Number(Number.isNaN(a.pr)) - Number(Number.isNaN(b.pr)) || a.index - b.index;
      }
      return a.pr - b.pr;
    })
    .map(({ line }) => line);
}

/**
 * Build the release section from fragments and pull requests without
 * fragment. `section` is null when there is no entry or a fragment is invalid.
 */
export function buildRelease({
  version,
  date,
  sections,
  references,
  fragments,
  pulls = [],
}: BuildReleaseOptions): BuiltRelease {
  const merged = new Map<string, string[]>(sections.map((title) => [title, []]));
  const prs = new Set<number>();
  const links: string[] = [];
  const used: string[] = [];
  const errors: FileIssue[] = [];

  for (const fragment of fragments) {
    const parsed = parseFragment(fragment.text, fragment.file, sections);
    errors.push(...parsed.errors);
    if (parsed.errors.length > 0 || parsed.sections.size === 0) continue;

    used.push(fragment.file);
    for (const [title, entries] of parsed.sections) {
      const target = merged.get(title)!;
      if (!fragment.pr) {
        target.push(...entries);
        continue;
      }
      const referenced = addReference(entries, `${references.prefix}${fragment.pr}`);
      target.push(...referenced.entries);
      if (referenced.added) prs.add(fragment.pr);
    }
    links.push(...parsed.links);
  }

  const credited = new Set(fragments.map((fragment) => fragment.pr).filter(Boolean));
  const dependencies = merged.get(sections.at(-1)!)!;
  for (const pull of pulls) {
    if (credited.has(pull.number)) continue;
    dependencies.push(`${titleToEntry(pull.title)} [[${references.prefix}${pull.number}]]`);
    prs.add(pull.number);
  }

  if (errors.length > 0 || [...merged.values()].every((entries) => entries.length === 0)) {
    return { section: null, body: '', used: [], errors };
  }

  const blocks: string[] = [];
  for (const [title, entries] of merged) {
    if (entries.length > 0) blocks.push(`### ${title}\n\n${entries.join('\n')}`);
  }

  const definitions = sortDefinitions([
    ...[...prs].map((pr) => `[${references.prefix}${pr}]: ${references.url(pr)}`),
    ...links,
  ]);
  if (definitions.length > 0) blocks.push(definitions.join('\n'));

  const body = blocks.join('\n\n');
  return { section: `## ${version} - ${date}\n\n${body}`, body, used, errors };
}

/**
 * Insert a release section before the first `## ` heading of the changelog,
 * or at its end when it has none. Throws when the version already has one.
 */
export function insertSection(changelog: string, section: string, version: string): string {
  const lines = changelog.split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = new RegExp(`^## ${escaped}( |$)`);
  if (lines.some((line) => existing.test(line))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  }

  const index = lines.findIndex((line) => line.startsWith('## '));
  if (index === -1) {
    return `${changelog.trimEnd()}\n\n${section}\n`;
  }
  lines.splice(index, 0, ...section.split('\n'), '');
  return lines.join('\n');
}

/**
 * True for a fragment path: a `.md` file directly in `.changelog/`, not a dot file.
 */
export function isFragmentPath(path: string): boolean {
  const prefix = `${FRAGMENTS_DIRECTORY}/`;
  if (!path.startsWith(prefix) || !path.endsWith('.md')) return false;
  const name = path.slice(prefix.length);
  return !name.includes('/') && !name.startsWith('.');
}
