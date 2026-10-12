#!/usr/bin/env node
// Command line entry: `check` validates fragments (and, on pull requests,
// requires one), `release` folds them into CHANGELOG.md.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRelease, insertSection, parseFragment } from './changelog.mjs';

const DIRECTORY = '.changelog';

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

/**
 * @param {Io} io
 * @param {{ file: string, line: number, message: string }[]} errors
 */
function reportErrors(io, errors) {
  for (const { file, line, message } of errors) {
    if (io.env.GITHUB_ACTIONS === 'true') {
      const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      io.error(`::error file=${file},line=${line}::${escaped}`);
    } else {
      io.error(`${file}:${line}: ${message}`);
    }
  }
}

/**
 * @param {Io} io
 * @param {string} path API path, starting with `/`.
 */
async function api(io, path) {
  const base = io.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (io.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${io.env.GITHUB_TOKEN}`;
  const response = await io.fetch(`${base}${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub API ${path} answered ${response.status}.`);
  return response.json();
}

/**
 * @param {Io} io
 * @param {number} pr
 */
async function listPullRequestFiles(io, pr) {
  const files = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(io, `/repos/${io.env.GITHUB_REPOSITORY}/pulls/${pr}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) return files;
  }
}

/**
 * Validate every fragment. On a pull request, also fail when files matching
 * `require-paths` change without a new or edited fragment.
 * @param {Io} io
 * @param {Record<string, string>} options
 */
export async function check(io, options) {
  const fragments = listFragments(io);
  const errors = fragments.flatMap((file) => parseFragment(readFileSync(join(io.cwd, file), 'utf8'), file).errors);
  reportErrors(io, errors);
  if (errors.length > 0) return 1;
  io.log(`${fragments.length} fragment(s) valid.`);

  const patterns = splitList(options['require-paths']);
  const event = io.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(io.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pullRequest = event.pull_request;
  if (patterns.length === 0 || !pullRequest) return 0;

  const skipLabel = options['skip-label'] || 'no-changelog';
  if (pullRequest.labels?.some((label) => label.name === skipLabel)) {
    io.log(`Label "${skipLabel}" is set: no fragment required.`);
    return 0;
  }

  const files = await listPullRequestFiles(io, pullRequest.number);
  const hasFragment = files.some(
    (file) =>
      file.status !== 'removed' &&
      file.filename.startsWith(`${DIRECTORY}/`) &&
      file.filename.endsWith('.md') &&
      !file.filename.slice(DIRECTORY.length + 1).includes('/'),
  );
  const matched = files
    .map((file) => file.filename)
    .filter((name) => patterns.some((pattern) => matchesGlob(name, pattern)));

  if (matched.length > 0 && !hasFragment) {
    reportErrors(io, [
      {
        file: DIRECTORY,
        line: 1,
        message: `This pull request changes ${matched.length} file(s) matching ${patterns.join(', ')} (e.g. ${matched[0]}) but adds no fragment in ${DIRECTORY}/. Add one, or set the "${skipLabel}" label.`,
      },
    ]);
    return 1;
  }
  return 0;
}

/**
 * Find the merged pull request that added a fragment.
 * @param {Io} io
 * @param {string} file
 * @returns {Promise<{ pr: number | null, time: number }>}
 */
async function resolveOrigin(io, file) {
  const [sha, time] = io.git(['log', '--diff-filter=A', '--format=%H %ct', '-1', '--', file]).trim().split(' ');
  if (!sha) return { pr: null, time: Number.POSITIVE_INFINITY };
  if (!io.env.GITHUB_REPOSITORY) return { pr: null, time: Number(time) };
  try {
    const pulls = await api(io, `/repos/${io.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`);
    const merged = pulls.find((pull) => pull.merged_at);
    return { pr: merged ? merged.number : null, time: Number(time) };
  } catch (error) {
    io.error(`Cannot find the pull request of ${file} (${sha}): ${error.message}`);
    return { pr: null, time: Number(time) };
  }
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
 * Fold the fragments into a new CHANGELOG.md section and delete them.
 * @param {Io} io
 * @param {Record<string, string>} options
 */
export async function release(io, options) {
  const version = options.version;
  if (!version) throw new Error('Missing --version.');
  const date = options.date || new Date().toISOString().slice(0, 10);

  const fragments = [];
  for (const file of listFragments(io)) {
    const text = readFileSync(join(io.cwd, file), 'utf8');
    if (text.trim() === '') continue;
    fragments.push({ file, text, ...(await resolveOrigin(io, file)) });
  }
  fragments.sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));

  const repositoryUrl = `${io.env.GITHUB_SERVER_URL || 'https://github.com'}/${io.env.GITHUB_REPOSITORY}`;
  const { section, body, used, errors } = buildRelease({ version, date, repositoryUrl, fragments });
  reportErrors(io, errors);
  if (errors.length > 0) {
    io.error('Invalid fragments: CHANGELOG.md and .changelog/ are unchanged.');
    return 1;
  }
  if (section === null) {
    io.log(`No fragment in ${DIRECTORY}/: CHANGELOG.md is unchanged.`);
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
    io.error('Usage: cli.mjs check [--require-paths <globs>] [--skip-label <label>]\n       cli.mjs release --version <version> [--date <YYYY-MM-DD>]');
    return 2;
  } catch (error) {
    io.error(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    fetch: globalThis.fetch,
    git: (args) => execFileSync('git', args, { encoding: 'utf8' }),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  });
}
