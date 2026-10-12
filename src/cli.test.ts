import { describe, expect, it, vi } from 'vitest';
import { HELP, main } from './cli.js';
import { makeDirectory, makeRuntime } from './test-utils.js';

const pkg = { name: '@weareikko/changelog', version: __PKG_VERSION__ };

describe('main', () => {
  it('prints the help with the package and binary names', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['help'], ['check', '--help']]) {
      const runtime = makeRuntime('/');
      expect(await main(argv, runtime)).toBe(0);
      expect(runtime.out).toEqual([HELP]);
    }
    expect(HELP).toContain(`${pkg.name} ${pkg.version}`);
    expect(HELP).toMatch(/^Usage: changelog check/);
    expect(HELP).not.toContain('cli.mjs');
  });

  it('prints the version', async () => {
    for (const argv of [['--version'], ['-v']]) {
      const runtime = makeRuntime('/');
      expect(await main(argv, runtime)).toBe(0);
      expect(runtime.out).toEqual([pkg.version]);
    }
  });

  it('exits 2 on a usage error', async () => {
    const runtime = makeRuntime('/');
    expect(await main(['publish'], runtime)).toBe(2);
    expect(runtime.err).toEqual([
      '[CONFIG_ERROR] Unknown command "publish".\nHint: Use check or release. Run "changelog --help".',
    ]);
  });

  it('runs a command and names the package, its version and the platform', async () => {
    const runtime = makeRuntime(makeDirectory({ '.changelog/.gitkeep': '' }), {
      env: { GITLAB_CI: 'true' },
    });
    expect(await main(['check'], runtime)).toBe(0);
    expect(runtime.err).toEqual([`${pkg.name} ${pkg.version}: check on gitlab`]);
    expect(runtime.out).toEqual(['0 fragment(s) valid.']);
  });

  it('exits 1 with the error and its hint when a command fails', async () => {
    const runtime = makeRuntime(makeDirectory());
    expect(await main(['release', '--version', '1.0.0'], runtime)).toBe(1);
    expect(runtime.err.at(-1)).toBe(
      '[CONFIG_ERROR] No .changelog/ directory.\nHint: Create it with a .changelog/.gitkeep file to start using fragments.',
    );
  });

  it('defaults to the process, with git in the given directory', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const writeError = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await main(['--version'])).toBe(0);
      expect(write).toHaveBeenCalledWith(`${pkg.version}\n`);
      expect(
        await main(['check'], {
          cwd: makeDirectory({ '.changelog/a.md': '### Added\n- A\n' }),
          env: {},
        }),
      ).toBe(0);
      expect(writeError).toHaveBeenCalled();
    } finally {
      write.mockRestore();
      writeError.mockRestore();
    }
  });
});
