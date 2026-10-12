#!/usr/bin/env node
// Command line entry: `check` validates fragments (and, on pull requests,
// requires one), `release` folds them into CHANGELOG.md, with the pull
// requests of `skip-authors` (e.g. Renovate) under Dependencies. Runs on
// GitHub Actions and GitLab CI: see platforms.mjs.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRelease, insertSection, parseFragment, SECTIONS } from './changelog.mjs';
import { createPlatform, detectPlatform } from './platforms.mjs';

const DIRECTORY = '.changelog';
const SKIP_LABEL = 'no-changelog';
const SKIP_AUTHORS = 'renovate[bot]';

const USAGE = `Usage: changelog check [--require-paths <globs>] [options]
       changelog release --version <version> [--date <YYYY-MM-DD>] [options]

Options:
  --skip-label <label>       Label that lifts the fragment requirement (default: ${SKIP_LABEL})
  --skip-authors <logins>    Authors that need no fragment; release lists their pull requests (default: ${SKIP_AUTHORS})
  --locale en|fr             Section names (default: en)
  --platform github|gitlab   API to read pull or merge requests from (default: gitlab in GitLab CI, else github)`;

/**
 * @typedef {object} Io
 * @property {string} cwd
 * @property {Record<string, string | undefined>} env
 * @property {typeof fetch} fetch
 * @property {(args: string[]) => string} git
 * @property {(message: string) => void} log
 * @property {(message: string) => void} error
 */

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const match = rest[index].match(/^--([a-z-]+)$/);
    if (!match) throw new Error(`Unexpected argument "${rest[index]}".`);
    options[match[1]] = rest[index + 1] ?? '';
    index += 1;
  }
  return { command, options };
}

/** @param {string | undefined} value */
function splitList(value) {
  return (value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The platform and the section names of a run.
 * @param {Io} io
 * @param {Record<string, string>} options
 */
function resolveContext(io, options) {
  const locale = options.locale || 'en';
  if (!Object.hasOwn(SECTIONS, locale)) {
    throw new Error(`Unknown locale "${locale}". Use ${Object.keys(SECTIONS).join(' or ')}.`);
  }
  return {
    platform: createPlatform(options.platform || detectPlatform(io.env), io),
    sections: SECTIONS[locale],
  };
}

/** @param {Io} io */
function listFragments(io) {
  const directory = join(io.cwd, DIRECTORY);
  if (!existsSync(directory)) {
    throw new Error(`No ${DIRECTORY}/ directory. Create it with a .gitkeep file to start using fragments.`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
    .map((entry) => `${DIRECTORY}/${entry.name}`)
    .sort();
}

/** @param {string} message */
function escapeAnnotation(message) {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * @param {Io} io
 * @param {{ file: string, line: number, message: string }[]} errors
 */
function reportErrors(io, errors) {
  for (const { file, line, message } of errors) {
    if (io.env.GITHUB_ACTIONS === 'true') {
      io.error(`::error file=${file},line=${line}::${escapeAnnotation(message)}`);
    } else {
      io.error(`${file}:${line}: ${message}`);
    }
  }
}

/**
 * @param {Io} io
 * @param {string} message
 */
function warn(io, message) {
  io.error(io.env.GITHUB_ACTIONS === 'true' ? `::warning::${escapeAnnotation(message)}` : `Warning: ${message}`);
}

/**
 * Validate every fragment. On a pull request, also fail when files matching
 * `require-paths` change without a new or edited fragment, unless the pull
 * request has the skip label or its author is in `skip-authors`.
 * @param {Io} io
 * @param {Record<string, string>} options
 */
export async function check(io, options) {
  const { platform, sections } = resolveContext(io, options);
  const fragments = listFragments(io);
  const errors = fragments.flatMap((file) => parseFragment(readFileSync(join(io.cwd, file), 'utf8'), file, sections).errors);
  reportErrors(io, errors);
  if (errors.length > 0) return 1;
  io.log(`${fragments.length} fragment(s) valid.`);

  const patterns = splitList(options['require-paths']);
  if (patterns.length === 0) return 0;
  const pull = await platform.currentPull();
  if (!pull) return 0;

  const skipLabel = options['skip-label'] || SKIP_LABEL;
  if (pull.labels.includes(skipLabel)) {
    io.log(`Label "${skipLabel}" is set: no fragment required.`);
    return 0;
  }

  if (splitList(options['skip-authors'] ?? SKIP_AUTHORS).includes(pull.author)) {
    io.log(`Author "${pull.author}" is in skip-authors: no fragment required.`);
    return 0;
  }

  const files = await platform.listFiles(pull.number);
  const hasFragment = files.some(
    (file) =>
      !file.removed &&
      file.path.startsWith(`${DIRECTORY}/`) &&
      file.path.endsWith('.md') &&
      !file.path.slice(DIRECTORY.length + 1).includes('/'),
  );
  const matched = files.map((file) => file.path).filter((path) => patterns.some((pattern) => matchesGlob(path, pattern)));

  if (matched.length > 0 && !hasFragment) {
    reportErrors(io, [
      {
        file: DIRECTORY,
        line: 1,
        message: `This ${platform.noun} changes ${matched.length} file(s) matching ${patterns.join(', ')} (e.g. ${matched[0]}) but adds no fragment in ${DIRECTORY}/. Add one, or set the "${skipLabel}" label.`,
      },
    ]);
    return 1;
  }
  return 0;
}

/**
 * Find the merged pull request that added a fragment.
 * @param {Io} io
 * @param {import('./platforms.mjs').Platform} platform
 * @param {string} file
 * @returns {Promise<{ pr: number | null, time: number }>}
 */
async function resolveOrigin(io, platform, file) {
  const [sha, time] = io.git(['log', '--diff-filter=A', '--format=%H %ct', '-1', '--', file]).trim().split(' ');
  if (!sha) return { pr: null, time: Number.POSITIVE_INFINITY };
  if (platform.missing) return { pr: null, time: Number(time) };
  try {
    const merged = await platform.findMergedPull(sha);
    return { pr: merged ? merged.number : null, time: Number(time) };
  } catch (error) {
    io.error(`Cannot find the ${platform.noun} of ${file} (${sha}): ${error.message}`);
    return { pr: null, time: Number(time) };
  }
}

/**
 * List the pull requests of `authors` merged since the previous tag, oldest
 * first, without the ones that have the skip label.
 * @param {Io} io
 * @param {import('./platforms.mjs').Platform} platform
 * @param {string[]} authors
 * @param {string} skipLabel
 * @returns {Promise<{ number: number, title: string }[]>}
 */
async function listAuthorPulls(io, platform, authors, skipLabel) {
  if (authors.length === 0 || platform.missing) return [];

  let tag = '';
  try {
    tag = io.git(['describe', '--tags', '--abbrev=0', 'HEAD']).trim();
  } catch {
    // No tag: this is the first release.
  }
  if (!tag) {
    io.log(`No previous tag: no ${platform.noun} from skip-authors to add.`);
    return [];
  }

  const shas = io.git(['log', '--first-parent', '--format=%H', `${tag}..HEAD`]).split('\n').filter(Boolean).reverse();
  const pulls = new Map();
  for (const sha of shas) {
    let pull;
    try {
      pull = await platform.findMergedPull(sha);
    } catch (error) {
      io.error(`Cannot find the ${platform.noun} of ${sha}: ${error.message}`);
      continue;
    }
    if (!pull || pulls.has(pull.number) || !authors.includes(pull.author) || pull.labels.includes(skipLabel)) {
      continue;
    }
    pulls.set(pull.number, { number: pull.number, title: pull.title });
  }
  return [...pulls.values()];
}

/**
 * @param {Io} io
 * @param {Record<string, string>} values
 */
function setOutputs(io, values) {
  if (!io.env.GITHUB_OUTPUT) return;
  for (const [name, value] of Object.entries(values)) {
    const delimiter = `EOF_${randomUUID()}`;
    appendFileSync(io.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

/**
 * Fold the fragments, and the pull requests of `skip-authors` merged since the
 * previous tag, into a new CHANGELOG.md section, and delete the fragments.
 * @param {Io} io
 * @param {Record<string, string>} options
 */
export async function release(io, options) {
  const version = options.version;
  if (!version) throw new Error('Missing --version.');
  const date = options.date || new Date().toISOString().slice(0, 10);
  const { platform, sections } = resolveContext(io, options);
  if (platform.missing) {
    warn(io, `${platform.missing}: no ${platform.noun} references and no entries from skip-authors.`);
  }

  const fragments = [];
  for (const file of listFragments(io)) {
    const text = readFileSync(join(io.cwd, file), 'utf8');
    if (text.trim() === '') continue;
    fragments.push({ file, text, ...(await resolveOrigin(io, platform, file)) });
  }
  fragments.sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));
  const pulls = await listAuthorPulls(
    io,
    platform,
    splitList(options['skip-authors'] ?? SKIP_AUTHORS),
    options['skip-label'] || SKIP_LABEL,
  );

  const { section, body, used, errors } = buildRelease({
    version,
    date,
    sections,
    references: platform.references,
    fragments,
    pulls,
  });
  reportErrors(io, errors);
  if (errors.length > 0) {
    io.error('Invalid fragments: CHANGELOG.md and .changelog/ are unchanged.');
    return 1;
  }
  if (section === null) {
    io.log(`No fragment in ${DIRECTORY}/ and no ${platform.noun} from skip-authors: CHANGELOG.md is unchanged.`);
    setOutputs(io, { changed: 'false', body: '' });
    return 0;
  }

  const changelogPath = join(io.cwd, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) throw new Error('CHANGELOG.md not found. Commit one before the first release.');
  writeFileSync(changelogPath, insertSection(readFileSync(changelogPath, 'utf8'), section, version));
  for (const file of used) rmSync(join(io.cwd, file));

  io.log(section);
  setOutputs(io, { changed: 'true', body });
  return 0;
}

/**
 * @param {string[]} argv
 * @param {Io} io
 */
export async function main(argv, io) {
  try {
    const { command, options } = parseArgs(argv);
    if (command === 'check') return await check(io, options);
    if (command === 'release') return await release(io, options);
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      io.log(USAGE);
      return 0;
    }
    io.error(USAGE);
    return 2;
  } catch (error) {
    io.error(error.message);
    return 1;
  }
}

// `realpathSync`: npm runs the `changelog` bin through a symbolic link.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    fetch: globalThis.fetch,
    // Pipe stderr: `git describe` without a tag must not print `fatal:` in
    // the job log. A failed command keeps the stderr in its error message.
    git: (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  });
}
