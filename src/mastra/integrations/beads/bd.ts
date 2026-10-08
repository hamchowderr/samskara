/**
 * SPIKE (samskara-iz6): the host-side bd copy for one linked repository.
 *
 * The host keeps one bootstrapped clone per repository in a cache directory and
 * is the ONLY automated writer to that repository's beads data. Sandboxes never
 * write. Everything goes through the `bd` CLI — never Dolt internals.
 *
 *   first use : git clone --depth 1  ->  bd --sandbox bootstrap --yes
 *   each poll : bd dolt pull          ->  bd --readonly ready --json
 *   write-back: bd --sandbox close    ->  bd sync (exit 2 conflict, 3 retry)
 *
 * Credentials: the GitHub App installation token is passed to git (and to the
 * git CLI Dolt shells out to for git+https remotes) through GIT_CONFIG_* env as
 * an http.extraheader, so it never appears in argv, a remote URL, or on disk.
 * The user's own credential helper is cleared so the proof cannot silently
 * borrow the owner's personal GitHub login.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BdResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface ReadyBead {
  id: string;
  title: string;
  status: string;
  priority?: number;
  issue_type?: string;
  parent?: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<BdResult> {
  const started = Date.now();
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), ms: Date.now() - started });
      },
    );
  });
}

/** Env for git/bd/dolt carrying the installation token as a header, never as argv. */
export function gitAuthEnv(token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    BD_NON_INTERACTIVE: '1',
    // Never create refs/dolt/remote-info branches on the origin (each one can
    // trigger a deploy on hosts that build every branch).
    DOLT_REMOTE_INFO_BRANCH: '',
    // Dolt's git remote cache nests deep under .beads/dolt; on Windows the
    // ref lock paths exceed MAX_PATH without this ("Filename too long").
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.longpaths',
    GIT_CONFIG_VALUE_0: 'true',
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '3';
    env.GIT_CONFIG_KEY_1 = 'credential.helper';
    env.GIT_CONFIG_VALUE_1 = '';
    env.GIT_CONFIG_KEY_2 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_2 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

/** Cache directory name for a repository slug (`owner/name`). */
export function cacheDirFor(root: string, slug: string): string {
  return join(root, slug.replace(/[^A-Za-z0-9._-]/g, '__'));
}

export class BdRepo {
  constructor(
    readonly slug: string,
    readonly dir: string,
    readonly cloneUrl: string,
  ) {}

  get bootstrapped(): boolean {
    // A marker, not `.beads/`: repos commit .beads/config.yaml, so a clone has
    // the directory long before bootstrap has built a database in it.
    return existsSync(join(this.dir, '.git', 'samskara-bd-bootstrapped'));
  }

  /** Clone + bootstrap on first use. Returns the timings, or throws with stderr. */
  async ensure(env: NodeJS.ProcessEnv, log: (msg: string) => void): Promise<void> {
    if (this.bootstrapped) return;
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    const clone = await run('git', ['clone', '--depth', '1', this.cloneUrl, '.'], { cwd: this.dir, env });
    if (clone.code !== 0) throw new Error(`git clone failed (${clone.code}): ${clone.stderr.slice(-500)}`);
    // Silences bd's GH#2950 role warning; this copy is a maintainer replica.
    await run('git', ['config', 'beads.role', 'maintainer'], { cwd: this.dir, env });
    const boot = await run('bd', ['--sandbox', 'bootstrap', '--yes'], { cwd: this.dir, env, timeoutMs: 300_000 });
    if (boot.code !== 0) {
      throw new Error(`bd bootstrap failed (${boot.code}): ${(boot.stderr || boot.stdout).slice(-500)}`);
    }
    await writeFile(join(this.dir, '.git', 'samskara-bd-bootstrapped'), new Date().toISOString());
    log(`[beads] bootstrapped ${this.slug}: clone ${clone.ms}ms, bootstrap ${boot.ms}ms`);
  }

  pull(env: NodeJS.ProcessEnv): Promise<BdResult> {
    return run('bd', ['dolt', 'pull'], { cwd: this.dir, env });
  }

  async ready(env: NodeJS.ProcessEnv): Promise<ReadyBead[]> {
    // Epics are containers, not work: `bd ready` lists an open epic with no
    // blockers alongside its first child, so they are excluded here.
    const res = await run('bd', ['--readonly', 'ready', '--json', '--brief', '--exclude-type=epic', '-n', '0'], {
      cwd: this.dir,
      env,
    });
    if (res.code !== 0) throw new Error(`bd ready failed (${res.code}): ${res.stderr.slice(-500)}`);
    const parsed = JSON.parse(res.stdout || '[]') as ReadyBead[];
    return Array.isArray(parsed) ? parsed : [];
  }

  async status(env: NodeJS.ProcessEnv, id: string): Promise<string | undefined> {
    const res = await run('bd', ['--readonly', 'show', id, '--json'], { cwd: this.dir, env });
    if (res.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(res.stdout) as unknown;
      const row = (Array.isArray(parsed) ? parsed[0] : parsed) as { status?: string } | undefined;
      return row?.status;
    } catch {
      return undefined;
    }
  }

  close(env: NodeJS.ProcessEnv, id: string, reason: string): Promise<BdResult> {
    return run('bd', ['--sandbox', 'close', id, '--reason', reason], { cwd: this.dir, env });
  }

  sync(env: NodeJS.ProcessEnv): Promise<BdResult> {
    return run('bd', ['sync'], { cwd: this.dir, env, timeoutMs: 300_000 });
  }
}
