import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatCodeQuality,
  formatDotenv,
  reportIssues,
  setGitHubOutputs,
  warn,
  writeOutputFile,
} from './output.js';
import { makeDirectory, makeRuntime } from './test-utils.js';

describe('reportIssues and warn', () => {
  it('print GitHub annotations in GitHub Actions', () => {
    const runtime = makeRuntime('/', { env: { GITHUB_ACTIONS: 'true' } });
    reportIssues(runtime, [{ file: 'a.md', line: 2, message: '50% off\r\nnow' }]);
    warn(runtime, 'careful\nnow');
    expect(runtime.err).toEqual([
      '::error file=a.md,line=2::50%25 off%0D%0Anow',
      '::warning::careful%0Anow',
    ]);
  });

  it('print file:line messages elsewhere', () => {
    const runtime = makeRuntime('/');
    reportIssues(runtime, [{ file: 'a.md', line: 2, message: 'Bad.' }]);
    warn(runtime, 'careful');
    expect(runtime.err).toEqual(['a.md:2: Bad.', 'Warning: careful']);
  });
});

describe('formatCodeQuality', () => {
  it('writes a GitLab Code Quality report with stable fingerprints', () => {
    const issue = {
      check: 'changelog-fragment' as const,
      file: '.changelog/a.md',
      line: 3,
      message: 'Bad.',
    };
    const report = JSON.parse(formatCodeQuality([issue]));
    expect(report).toEqual([
      {
        description: 'Bad.',
        check_name: 'changelog-fragment',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        severity: 'major',
        location: { path: '.changelog/a.md', lines: { begin: 3 } },
      },
    ]);
    const moved = JSON.parse(formatCodeQuality([{ ...issue, line: 9 }]));
    expect(moved[0].fingerprint).toBe(report[0].fingerprint);
    const other = JSON.parse(formatCodeQuality([{ ...issue, message: 'Other.' }]));
    expect(other[0].fingerprint).not.toBe(report[0].fingerprint);
    expect(formatCodeQuality([])).toBe('[]\n');
  });
});

describe('formatDotenv', () => {
  it('writes KEY=value lines', () => {
    expect(formatDotenv({ A: 'true', B: '1.2.0' })).toBe('A=true\nB=1.2.0\n');
  });
});

describe('writeOutputFile', () => {
  it('writes relative to the working directory and creates the directory', () => {
    const cwd = makeDirectory();
    writeOutputFile(makeRuntime(cwd), 'reports/x.json', '[]');
    expect(readFileSync(join(cwd, 'reports/x.json'), 'utf8')).toBe('[]');
  });
});

describe('setGitHubOutputs', () => {
  it('appends multi-line outputs with a random delimiter', () => {
    const cwd = makeDirectory({ output: '' });
    const file = join(cwd, 'output');
    setGitHubOutputs(makeRuntime(cwd, { env: { GITHUB_OUTPUT: file } }), {
      changed: 'true',
      body: 'a\nb',
    });
    expect(readFileSync(file, 'utf8')).toMatch(
      /^changed<<(EOF_[0-9a-f-]+)\ntrue\n\1\nbody<<(EOF_[0-9a-f-]+)\na\nb\n\2\n$/,
    );
  });

  it('does nothing without GITHUB_OUTPUT', () => {
    expect(() => setGitHubOutputs(makeRuntime('/'), { changed: 'true' })).not.toThrow();
  });
});
