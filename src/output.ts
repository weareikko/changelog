import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FileIssue } from './changelog.js';
import type { Git } from './git.js';

/** Everything a command touches outside of its config, injectable in tests. */
export interface Runtime {
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  git: Git;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** An issue with the Code Quality check it belongs to. */
export interface CheckIssue extends FileIssue {
  check: 'changelog-fragment' | 'changelog-missing-fragment' | 'changelog-prerelease';
}

function escapeAnnotation(message: string): string {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function inGitHubActions(runtime: Runtime): boolean {
  return runtime.env.GITHUB_ACTIONS === 'true';
}

/** Report issues as GitHub annotations in GitHub Actions, else as `file:line: message`. */
export function reportIssues(runtime: Runtime, issues: FileIssue[]): void {
  for (const { file, line, message } of issues) {
    runtime.stderr(
      inGitHubActions(runtime)
        ? `::error file=${file},line=${line}::${escapeAnnotation(message)}`
        : `${file}:${line}: ${message}`,
    );
  }
}

export function warn(runtime: Runtime, message: string): void {
  runtime.stderr(
    inGitHubActions(runtime) ? `::warning::${escapeAnnotation(message)}` : `Warning: ${message}`,
  );
}

/** Write a file relative to the working directory, creating its directory. */
export function writeOutputFile(runtime: Runtime, path: string, text: string): void {
  const target = resolve(runtime.cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/**
 * A GitLab Code Quality report (the Code Climate subset GitLab reads). The
 * fingerprint hashes the check, the file and the message, so the same
 * problem keeps its fingerprint from one pipeline to the next.
 */
export function formatCodeQuality(issues: CheckIssue[]): string {
  const report = issues.map((issue) => ({
    description: issue.message,
    check_name: issue.check,
    fingerprint: createHash('sha256')
      .update(`${issue.check}\0${issue.file}\0${issue.message}`)
      .digest('hex'),
    severity: 'major',
    location: { path: issue.file, lines: { begin: issue.line } },
  }));
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** `KEY=value` lines for a GitLab `artifacts:reports:dotenv` file. */
export function formatDotenv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
    .concat('\n');
}

/** Append step outputs to `GITHUB_OUTPUT`, when it is set. */
export function setGitHubOutputs(runtime: Runtime, values: Record<string, string>): void {
  const file = runtime.env.GITHUB_OUTPUT;
  if (!file) return;
  for (const [name, value] of Object.entries(values)) {
    const delimiter = `EOF_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}
