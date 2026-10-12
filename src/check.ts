import { matchesGlob } from 'node:path';
import { FRAGMENTS_DIRECTORY, isFragmentPath, parseFragment } from './changelog.js';
import type { Config } from './config.js';
import { readFragments, readPrerelease } from './fragments.js';
import { listChangedFiles } from './git.js';
import {
  type CheckIssue,
  formatCodeQuality,
  reportIssues,
  type Runtime,
  writeOutputFile,
} from './output.js';
import type { Platform } from './platform.js';

/**
 * The issue of a change that touches `requirePaths` without a fragment, or
 * null when it needs none.
 */
async function findMissingFragment(
  config: Config,
  platform: Platform,
  runtime: Runtime,
): Promise<CheckIssue | null> {
  const change = await platform.currentChange();
  if (!change) {
    runtime.stdout(`No open ${platform.noun} for this run: no fragment required.`);
    return null;
  }

  if (change.labels.includes(config.skipLabel)) {
    runtime.stdout(`Label "${config.skipLabel}" is set: no fragment required.`);
    return null;
  }

  if (config.skipAuthors.length > 0) {
    const author = await change.author();
    if (author && config.skipAuthors.includes(author)) {
      runtime.stdout(`Author "${author}" is in skip-authors: no fragment required.`);
      return null;
    }
  }

  const files = await listChangedFiles(runtime.git, change.baseSha);
  if (files.some((file) => !file.removed && isFragmentPath(file.path))) return null;

  const matched = files
    .map((file) => file.path)
    .filter((path) => config.requirePaths.some((pattern) => matchesGlob(path, pattern)));
  if (matched.length === 0) return null;

  return {
    check: 'changelog-missing-fragment',
    file: FRAGMENTS_DIRECTORY,
    line: 1,
    message:
      `This ${platform.noun} changes ${matched.length} file(s) matching ${config.requirePaths.join(', ')} ` +
      `(e.g. ${matched[0]}) but adds no fragment in ${FRAGMENTS_DIRECTORY}/. ` +
      `Add one, or set the "${config.skipLabel}" label.`,
  };
}

/**
 * Validate every fragment and the prerelease file. With `requirePaths`, also fail when the open pull
 * or merge request of the run changes a matching file without adding or
 * editing a fragment, unless it has the skip label or its author is in
 * `skipAuthors`. Returns the exit code.
 */
export async function check(config: Config, platform: Platform, runtime: Runtime): Promise<number> {
  const fragments = readFragments(runtime.cwd);
  const issues: CheckIssue[] = fragments.flatMap(({ file, text }) =>
    parseFragment(text, file, config.sections).errors.map((error) => ({
      ...error,
      check: 'changelog-fragment' as const,
    })),
  );
  if (issues.length === 0) runtime.stdout(`${fragments.length} fragment(s) valid.`);

  const prerelease = readPrerelease(runtime.cwd);
  issues.push(
    ...prerelease.errors.map((error) => ({ ...error, check: 'changelog-prerelease' as const })),
  );
  if (prerelease.id) runtime.stdout(`Prerelease "${prerelease.id}": releases are prereleases.`);

  if (config.requirePaths.length > 0) {
    const missing = await findMissingFragment(config, platform, runtime);
    if (missing) issues.push(missing);
  }

  reportIssues(runtime, issues);
  if (config.codequality) writeOutputFile(runtime, config.codequality, formatCodeQuality(issues));
  return issues.length > 0 ? 1 : 0;
}
