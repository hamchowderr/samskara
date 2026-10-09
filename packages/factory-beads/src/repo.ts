/**
 * The host-side bd copy of one repository.
 *
 * The host keeps one bootstrapped clone per repository in a cache directory and
 * is the ONLY automated writer to that repository's beads data; sandboxes never
 * write. Everything goes through the `bd` CLI, never Dolt internals.
 *
 *   first use : git clone --depth 1  ->  bd --sandbox bootstrap --yes
 *   each poll : bd dolt pull         ->  bd --readonly ready --json (with descriptions)
 *   write-back: bd --sandbox close   ->  bd sync (exit 2 conflict, 3 retry)
 *
 * `--sandbox` disables Dolt auto-push (bd --help), so a close is published only
 * by the explicit `bd sync`, whose exit code is the outcome the worker branches
 * on. `--readonly` blocks writes on every read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BdResult, BdRunner, RepoCredentials } from './runner';

export interface ReadyBead {
  id: string;
  title: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  /** Absent when the bead has none: bd omits empty text fields from JSON. */
  description?: string;
}

const MARKER = 'factory-beads-bootstrapped';
const PARKED = 'factory-beads-parked';

/** Cache directory for a repository slug (`owner/name`). */
export function cacheDirFor(root: string, slug: string): string {
  return join(root, slug.replace(/[^A-Za-z0-9._-]/g, '__'));
}

function tail(result: BdResult, chars = 500): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-chars);
}

export class BdRepo {
  constructor(
    readonly slug: string,
    readonly dir: string,
    readonly cloneUrl: string,
    readonly runner: BdRunner,
  ) {}

  get bootstrapped(): boolean {
    // A marker, not `.beads/`: repos commit .beads/config.yaml, so a clone has
    // the directory long before bootstrap has built a database in it.
    return existsSync(join(this.dir, '.git', MARKER));
  }

  /** Clone and bootstrap on first use. Throws with a redacted stderr tail. */
  async ensure(credentials: RepoCredentials | undefined): Promise<{ cloneMs: number; bootstrapMs: number } | undefined> {
    if (this.bootstrapped) return undefined;
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    const opts = { cwd: this.dir, credentials };
    const clone = await this.runner.git(['clone', '--depth', '1', this.cloneUrl, '.'], opts);
    if (clone.code !== 0) throw new Error(`git clone failed (exit ${clone.code}): ${tail(clone)}`);
    // Silences bd's GH#2950 role warning: this copy is a maintainer replica.
    await this.runner.git(['config', 'beads.role', 'maintainer'], opts);
    const boot = await this.runner.bd(['--sandbox', 'bootstrap', '--yes'], { ...opts, timeoutMs: 300_000 });
    if (boot.code !== 0) throw new Error(`bd bootstrap failed (exit ${boot.code}): ${tail(boot)}`);
    await writeFile(join(this.dir, '.git', MARKER), new Date().toISOString());
    return { cloneMs: clone.ms, bootstrapMs: boot.ms };
  }

  /**
   * Park the copy: an agent-tool write hit a `bd sync` conflict, so the copy
   * holds a commit that cannot be published. The marker lives in the copy's
   * own `.git`, so it lasts exactly as long as the conflicted copy does: an
   * operator reset discards both.
   */
  async park(reason: string): Promise<void> {
    await writeFile(join(this.dir, '.git', PARKED), reason);
  }

  /** Why the copy is parked, or undefined when it is not. */
  parkedReason(): string | undefined {
    const file = join(this.dir, '.git', PARKED);
    if (!existsSync(file)) return undefined;
    try {
      return readFileSync(file, 'utf8') || 'parked';
    } catch {
      return 'parked';
    }
  }

  /** Drop the copy; the next `ensure` re-bootstraps from the remote. */
  async discard(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  pull(credentials: RepoCredentials | undefined): Promise<BdResult> {
    return this.runner.bd(['dolt', 'pull'], { cwd: this.dir, credentials });
  }

  /**
   * Ready, non-epic beads. Epics are containers: `bd ready` lists an unblocked epic beside its first child.
   * No `--brief`: in bd 1.3.0 it omits description, design, acceptance and notes (`bd ready --help`),
   * and the description is posted to the card's feed.
   */
  async ready(): Promise<ReadyBead[]> {
    const res = await this.runner.bd(['--readonly', 'ready', '--json', '--exclude-type=epic', '-n', '0'], {
      cwd: this.dir,
    });
    if (res.code !== 0) throw new Error(`bd ready failed (exit ${res.code}): ${tail(res)}`);
    const parsed = JSON.parse(res.stdout.trim() || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    // Belt and braces: never card an epic even if a bd version ignores the flag.
    return (parsed as ReadyBead[]).filter(bead => typeof bead?.id === 'string' && bead.issue_type !== 'epic');
  }

  /** The bead's status, or undefined when bd cannot read it. */
  async status(id: string): Promise<string | undefined> {
    const res = await this.runner.bd(['--readonly', 'show', id, '--json'], { cwd: this.dir });
    if (res.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(res.stdout) as unknown;
      const row = (Array.isArray(parsed) ? parsed[0] : parsed) as { status?: string } | undefined;
      return row?.status;
    } catch {
      return undefined;
    }
  }

  close(id: string, reason: string): Promise<BdResult> {
    return this.runner.bd(['--sandbox', '--actor', this.runner.actor, 'close', id, '--reason', reason], { cwd: this.dir });
  }

  sync(credentials: RepoCredentials | undefined): Promise<BdResult> {
    return this.runner.bd(['sync'], { cwd: this.dir, credentials, timeoutMs: 300_000 });
  }
}

export { tail as resultTail };
