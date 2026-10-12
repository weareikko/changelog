export type ErrorCode = 'CONFIG_ERROR' | 'GITLAB_API_ERROR' | 'GITHUB_API_ERROR' | 'GIT_ERROR';

export interface ChangelogErrorOptions extends ErrorOptions {
  /** What the user can do about it. Never contains a secret. */
  hint?: string;
}

/** An error the CLI reports with its code and an actionable hint. */
export class ChangelogError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(message: string, code: ErrorCode, options: ChangelogErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.hint = options.hint;
  }
}

export class ConfigError extends ChangelogError {
  constructor(message: string, options: ChangelogErrorOptions = {}) {
    super(message, 'CONFIG_ERROR', options);
  }
}

export class GitError extends ChangelogError {
  constructor(message: string, options: ChangelogErrorOptions = {}) {
    super(message, 'GIT_ERROR', options);
  }
}

export interface ApiErrorOptions extends ChangelogErrorOptions {
  path: string;
  status?: number;
}

export class GitLabApiError extends ChangelogError {
  readonly path: string;
  readonly status?: number;

  constructor(message: string, options: ApiErrorOptions) {
    super(message, 'GITLAB_API_ERROR', options);
    this.path = options.path;
    this.status = options.status;
  }
}

export class GitHubApiError extends ChangelogError {
  readonly path: string;
  readonly status?: number;

  constructor(message: string, options: ApiErrorOptions) {
    super(message, 'GITHUB_API_ERROR', options);
    this.path = options.path;
    this.status = options.status;
  }
}

/** One line per fact: `[CODE] message`, then `Hint: …` when there is one. */
export function formatError(error: unknown): string {
  if (error instanceof ChangelogError) {
    const lines = [`[${error.code}] ${error.message}`];
    if (error.hint) lines.push(`Hint: ${error.hint}`);
    return lines.join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}
