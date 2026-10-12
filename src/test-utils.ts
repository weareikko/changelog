// Test helpers: a temporary working directory, a recording runtime, and a
// fetch that answers from a route table. Not part of the package.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { Git } from './git.js';
import type { Runtime } from './output.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A temporary directory with these files, removed after the test. */
export function makeDirectory(files: Record<string, string> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'changelog-test-'));
  directories.push(directory);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

export interface RecordingRuntime extends Runtime {
  out: string[];
  err: string[];
}

export function makeRuntime(cwd: string, overrides: Partial<Runtime> = {}): RecordingRuntime {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    env: {},
    fetch: vi.fn<typeof fetch>(() => Promise.reject(new Error('Unexpected fetch'))),
    git: vi.fn<Git>(() => Promise.reject(new Error('Unexpected git call'))),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
    out,
    err,
  };
}

/**
 * A fetch that answers each request from the first route whose key the URL
 * (path and query, without the origin) starts with. A value is the JSON body
 * of a 200 response, or a Response.
 */
export function routeFetch(routes: Record<string, unknown>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const key = Object.keys(routes).find((route) =>
      `${url.pathname}${url.search}`.startsWith(route),
    );
    if (key === undefined) return new Response('{"message":"404 Not Found"}', { status: 404 });
    const value = routes[key];
    return value instanceof Response ? value.clone() : Response.json(value);
  });
}

/** A git that answers from a table keyed by its joined arguments. */
export function tableGit(table: Record<string, string | Error>): Git {
  return vi.fn<Git>(async (args) => {
    const key = args.join(' ');
    if (!(key in table)) throw new Error(`Unexpected git ${key}`);
    const value = table[key];
    if (value instanceof Error) throw value;
    return value;
  });
}
