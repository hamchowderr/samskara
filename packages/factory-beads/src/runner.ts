/**
 * Runs `bd` and `git` for the host-side beads copy.
 *
 * Credentials. The GitHub App installation token reaches git (and the git CLI
 * Dolt shells out to for `git+https` remotes) through the child's ENVIRONMENT
 * only: `BEADS_GIT_TOKEN` holds it, and a git credential helper configured via
 * `GIT_CONFIG_*` prints it when git asks. It is never in argv, a remote URL, a
 * config file, or a log line; surfaced output is passed through `redact()`.
 * The helper list is reset first, so the host's own credential manager can
 * never silently stand in for the App.
 *
 * Environment. The child gets an allowlisted environment, not the server's: the
 * server process holds every application secret, and bd has no use for them.
 */
import { execFile } from 'node:child_process';

export const TOKEN_ENV = 'BEADS_GIT_TOKEN';
export const TOKEN_USER_ENV = 'BEADS_GIT_USERNAME';

/**
 * A git credential helper that answers `get` from the environment. `!` makes
 * git run it through its shell; the token is expanded there, at request time,
 * from the child's environment.
 */
export const CREDENTIAL_HELPER = `!f() { test "$1" = get || return 0; echo "username=\${${TOKEN_USER_ENV}:-x-access-token}"; echo "password=$${TOKEN_ENV}"; }; f`;

/** Host variables bd, git and Dolt need to find themselves, a home, and the network. */
const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

export interface RepoCredentials {
  token: string;
  username?: string;
}

export interface BdResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

export interface BdRunnerOptions {
  /** `bd` executable. Defaults to `bd` on PATH. */
  bdPath?: string;
  /** Arguments placed before every bd invocation, e.g. a script when `bdPath` is node. */
  bdArgs?: readonly string[];
  /** `git` executable. Defaults to `git` on PATH. */
  gitPath?: string;
  /** Recorded on every bead write (`bd --actor`) and as the Dolt/git author. */
  actor?: string;
  /** Extra variables for the child, e.g. a test's PATH. Never put a token here. */
  env?: NodeJS.ProcessEnv;
  /** Default per-command timeout. */
  timeoutMs?: number;
}

export interface RunOptions {
  cwd: string;
  credentials?: RepoCredentials;
  timeoutMs?: number;
}

/** Remove a token, and the encodings git could echo it in, from text. */
export function redact(text: string, token: string | undefined): string {
  if (!token) return text;
  let out = text;
  for (const form of [token, Buffer.from(`x-access-token:${token}`).toString('base64'), encodeURIComponent(token)]) {
    if (form) out = out.split(form).join('[REDACTED]');
  }
  return out;
}

/** The child environment for one command. Exported for tests. */
export function childEnv(options: { actor: string; extra?: NodeJS.ProcessEnv; credentials?: RepoCredentials }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.extra);
  const config: Array<[string, string]> = [
    // Dolt's git remote cache nests deep under .beads/dolt; on Windows the
    // ref lock paths exceed MAX_PATH without this ("Filename too long").
    ['core.longpaths', 'true'],
    // An empty value resets the helper list, so a credential manager from the
    // system or global config is never consulted.
    ['credential.helper', ''],
    ['user.name', options.actor],
    ['user.email', 'factory-beads@localhost'],
  ];
  if (options.credentials) config.push(['credential.helper', CREDENTIAL_HELPER]);
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    BD_NON_INTERACTIVE: '1',
    BEADS_ACTOR: options.actor,
    // Never create refs/dolt/remote-info branches on the origin: on hosts that
    // build every pushed branch, each one can trigger a deploy.
    DOLT_REMOTE_INFO_BRANCH: '',
    GIT_AUTHOR_NAME: options.actor,
    GIT_AUTHOR_EMAIL: 'factory-beads@localhost',
    GIT_COMMITTER_NAME: options.actor,
    GIT_COMMITTER_EMAIL: 'factory-beads@localhost',
    GIT_CONFIG_COUNT: String(config.length),
  });
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (options.credentials) {
    env[TOKEN_ENV] = options.credentials.token;
    if (options.credentials.username) env[TOKEN_USER_ENV] = options.credentials.username;
  }
  return env;
}

export class BdRunner {
  readonly bdPath: string;
  readonly bdArgs: readonly string[];
  readonly gitPath: string;
  readonly actor: string;
  readonly #extraEnv: NodeJS.ProcessEnv | undefined;
  readonly #timeoutMs: number;

  constructor(options: BdRunnerOptions = {}) {
    this.bdPath = options.bdPath ?? 'bd';
    this.bdArgs = options.bdArgs ?? [];
    this.gitPath = options.gitPath ?? 'git';
    this.actor = options.actor ?? 'factory-beads';
    this.#extraEnv = options.env;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  bd(args: readonly string[], options: RunOptions): Promise<BdResult> {
    return this.#run(this.bdPath, [...this.bdArgs, ...args], options);
  }

  git(args: readonly string[], options: RunOptions): Promise<BdResult> {
    return this.#run(this.gitPath, args, options);
  }

  #run(file: string, args: readonly string[], options: RunOptions): Promise<BdResult> {
    const token = options.credentials?.token;
    if (token && args.some(arg => arg.includes(token))) {
      // A programming error, caught before anything can log the argv.
      throw new Error('factory-beads: refusing to pass a credential in argv');
    }
    const env = childEnv({ actor: this.actor, extra: this.#extraEnv, credentials: options.credentials });
    const started = Date.now();
    return new Promise(resolve => {
      execFile(
        file,
        [...args],
        {
          cwd: options.cwd,
          env,
          timeout: options.timeoutMs ?? this.#timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string }) | null;
          const timedOut = Boolean(err?.killed && err.signal);
          const code = !err ? 0 : typeof err.code === 'number' ? err.code : timedOut ? 124 : 127;
          resolve({
            code,
            stdout: redact(String(stdout ?? ''), token),
            stderr: redact(String(stderr ?? '') || (err && typeof err.code !== 'number' ? String(err.message) : ''), token),
            ms: Date.now() - started,
            timedOut,
          });
        },
      );
    });
  }
}
