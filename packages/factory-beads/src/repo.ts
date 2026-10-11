/**
 * The host-side bd copy of one repository.
 *
 * The host keeps one bootstrapped clone per repository in a cache directory and
 * is the ONLY automated writer to that repository's beads data; sandboxes never
 * write. Everything goes through the `bd` CLI, never Dolt internals.
 *
 *   first use : git clone --depth 1  ->  bd --sandbox bootstrap --yes
 *   each poll : bd dolt pull         ->  bd --readonly ready --brief --json
 *                                    ->  bd --readonly list --all --brief --json (the refresh)
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
  /** The parent bead's id, from its parent-child edge; absent for a top-level bead. */
  parent?: string;
  /** A gate's condition type (BeadRow.await_type); intake adds human gates from the refresh read. */
  await_type?: string;
}

/** One bead as `bd show --json` returns it: the fields the integration reads. */
export interface BeadDetails {
  id: string;
  title?: string;
  status?: string;
  assignee?: string;
  priority?: number;
  issue_type?: string;
  parent?: string;
  description?: string;
  await_type?: string;
}

/** The summary `bd gate check --json` prints after its per-gate lines (bd 1.3.1). */
export interface GateCheckSummary {
  checked?: number;
  resolved?: number;
  escalated?: number;
  errors?: number;
}

/** One comment as `bd comments <id> --json` prints it (bd 1.3.1). */
export interface BeadComment {
  id: string;
  issue_id?: string;
  author?: string;
  text: string;
  created_at?: string;
}

/**
 * One row of `bd list --all --brief --json`: a bead as the per-sweep refresh
 * reads it. Checked on bd 1.3.1: every row carries id, title, status,
 * priority, issue_type, created_at, updated_at and comment_count; bd omits an
 * empty field, so assignee, labels, parent, dependencies, closed_at and
 * close_reason appear only when set. `--brief` drops the free-form text
 * (description, design, acceptance criteria, notes), so a row never carries
 * a description: read one with `bd show`.
 *
 * Carried for the consumers of the refresh (samskara-l2t.15): status and
 * close_reason for the inbound close (l2t.3) and two-way status sync (l2t.4),
 * comment_count for bd comments on the feed (l2t.6), title for the card title
 * (l2t.8), labels and assignee for label chips (l2t.5), updated_at to tell a
 * changed bead, await_type for approval cards (l2t.9), defer_until to wake
 * a snoozed bead (l2t.14).
 */
export interface BeadRow {
  id: string;
  title?: string;
  status?: string;
  /** Absent for an open bead and for a superseded or duplicate one (bd 1.3.1 leaves it empty). */
  close_reason?: string;
  closed_at?: string;
  priority?: number;
  issue_type?: string;
  assignee?: string;
  labels?: string[];
  /** The lowest parent-child target (bd 1.3.1 internal/storage/sqlbuild/counts.go:239, `MIN(...)`). */
  parent?: string;
  comment_count?: number;
  updated_at?: string;
  /** A gate's condition type: `human`, `timer`, `gh:run`, `gh:pr` or `bead` (bd gate --help). */
  await_type?: string;
  /** A deferred bead's wake time (`bd defer --until`); absent for one deferred with no date. */
  defer_until?: string;
  /** A gate's condition: a PR number, a run id, or a bead id (bd gate create --await-id). */
  await_id?: string;
  /** A timer gate's timeout, in nanoseconds (checked on bd 1.3.1: `--timeout=1m` is 60000000000). */
  timeout?: number;
  created_at?: string;
  /** Every dependency edge of the bead, parent-child included. */
  dependencies?: Array<{ issue_id?: string; depends_on_id?: string; type?: string }>;
}

/**
 * Every bead `bd list --all` returns, by id, with each bead's direct
 * children: one read per repository per sweep (samskara-l2t.15).
 *
 * `children(id)` answers exactly what `bd list --parent=<id> --all` would on
 * the same copy. Both go through the same list filter
 * (bd v1.3.1 internal/workapi/list.go:186-453: `--parent` only adds
 * `ParentID`), whose parent clause is (internal/storage/sqlbuild/filter.go:174-178):
 *
 *   - every bead with a parent-child edge to `id`, a bead with two parents
 *     included under each; the row's own `parent` names only the lowest one,
 *     so the edges are read from `dependencies`; and
 *   - every bead whose id starts with `<id>.` and that has no parent-child
 *     edge at all: a dotted id with no edge (an import, say) is a child of
 *     EVERY dotted prefix of it, grandparent included (checked on bd 1.3.1:
 *     an edge-less `x.1.9.1` is listed under both `x` and `x.1`).
 */
export class BeadSnapshot {
  readonly #rows = new Map<string, BeadRow>();
  readonly #children = new Map<string, BeadRow[]>();
  readonly #blocking = new Map<string, BeadRow[]>();

  constructor(rows: readonly BeadRow[]) {
    for (const row of rows) this.#rows.set(row.id, row);
    for (const row of this.#rows.values()) {
      const parents = new Set<string>();
      for (const dep of row.dependencies ?? []) {
        if (dep?.type === 'parent-child' && typeof dep.depends_on_id === 'string') parents.add(dep.depends_on_id);
      }
      // A row from a bd that names the parent without the edge list.
      if (parents.size === 0 && row.dependencies === undefined && row.parent) parents.add(row.parent);
      if (parents.size === 0) {
        for (let dot = row.id.indexOf('.'); dot > 0; dot = row.id.indexOf('.', dot + 1)) parents.add(row.id.slice(0, dot));
      }
      for (const parent of parents) {
        const list = this.#children.get(parent);
        if (list) list.push(row);
        else this.#children.set(parent, [row]);
      }
      for (const dep of row.dependencies ?? []) {
        if (dep?.type !== 'blocks' || typeof dep.depends_on_id !== 'string') continue;
        const list = this.#blocking.get(dep.depends_on_id);
        if (list) list.push(row);
        else this.#blocking.set(dep.depends_on_id, [row]);
      }
    }
  }

  /** The bead, or undefined when the list does not have it (bd leaves templates and wisps out). */
  get(id: string): BeadRow | undefined {
    return this.#rows.get(id);
  }

  /** The bead's direct children, closed ones included. */
  children(id: string): readonly BeadRow[] {
    return this.#children.get(id) ?? [];
  }

  /** The beads this bead blocks: each one with a `blocks` edge to it. */
  blocks(id: string): readonly BeadRow[] {
    return this.#blocking.get(id) ?? [];
  }

  /** Every bead the list returned. */
  values(): IterableIterator<BeadRow> {
    return this.#rows.values();
  }

  get size(): number {
    return this.#rows.size;
  }
}

/** Issue types that group work and are never carded as work themselves. */
export const CONTAINER_TYPES = ['epic', 'milestone'] as const;

/**
 * Issue types whose children get an overview card above them. A poured
 * molecule's root is of type `molecule`, and every poured step carries a
 * parent-child edge to it (bd v1.3.1 cmd/bd/cook.go:643-649); bd ready never
 * lists the root itself (internal/storage/sqlbuild/ready.go:16-38).
 */
export const OVERVIEW_TYPES = [...CONTAINER_TYPES, 'molecule'] as const;

/**
 * Issue types `ready` leaves out: a milestone is only ever a parent (an
 * overview card above its children, or no card). An epic is read: one with
 * children becomes an overview card, a childless open one a planning card
 * (samskara-l2t.2.4). A molecule root bd ready never lists.
 */
export const NEVER_READY_TYPES = ['milestone'] as const;

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
   * Ready beads, milestones left out. Epics and milestones are containers ("contains no work itself",
   * `bd types`), and bd ready returns both (bd v1.3.1 internal/storage/sqlbuild/ready.go:16-38 excludes
   * neither; an epic with open children is listed too, checked on bd 1.3.1). Epics are read so that a
   * childless one can be carded for planning; the caller tells the two kinds of epic apart. Pinned beads,
   * gates and molecule roots bd already leaves out (`:117`, `:16-38`).
   * `--brief`: it drops the free-form text (description, design, acceptance, notes; `bd ready --help`),
   * which intake does not need since the kickoff hint sends the agent to beads_show (samskara-l2t.8). It
   * keeps id, title, status, priority, issue_type and parent (checked on bd 1.3.1).
   */
  async ready(): Promise<ReadyBead[]> {
    const res = await this.runner.bd(
      ['--readonly', 'ready', '--brief', '--json', `--exclude-type=${NEVER_READY_TYPES.join(',')}`, '-n', '0'],
      { cwd: this.dir },
    );
    if (res.code !== 0) throw new Error(`bd ready failed (exit ${res.code}): ${tail(res)}`);
    const parsed = JSON.parse(res.stdout.trim() || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    // Belt and braces: never read a milestone even if a bd version ignores the flag.
    return (parsed as ReadyBead[]).filter(
      bead => typeof bead?.id === 'string' && !(NEVER_READY_TYPES as readonly string[]).includes(bead.issue_type ?? ''),
    );
  }

  /** The bead as `bd show` reads it, or undefined when bd cannot read it. */
  async show(id: string): Promise<BeadDetails | undefined> {
    const res = await this.runner.bd(['--readonly', 'show', id, '--json'], { cwd: this.dir });
    if (res.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(res.stdout) as unknown;
      const row = (Array.isArray(parsed) ? parsed[0] : parsed) as BeadDetails | undefined;
      return row && typeof row === 'object' ? row : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The bead's comments, oldest first (samskara-l2t.6). Throws when bd fails
   * or prints something that is not a list, so a failed read is never taken
   * for "no comments". Each comment's id is a UUIDv5 of its content, the same
   * on every copy of the repository (bd 1.3.1), so it can key the comment on
   * the card's feed.
   */
  async comments(id: string): Promise<BeadComment[]> {
    const res = await this.runner.bd(['--readonly', 'comments', id, '--json'], { cwd: this.dir });
    if (res.code !== 0) throw new Error(`bd comments ${id} failed (exit ${res.code}): ${tail(res)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout.trim() || '[]') ?? [];
    } catch {
      throw new Error(`bd comments ${id} printed no JSON: ${tail(res, 200)}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`bd comments ${id} printed no list`);
    return (parsed as BeadComment[]).filter(c => typeof c?.id === 'string' && typeof c.text === 'string');
  }

  /** The bead's status, or undefined when bd cannot read it. */
  async status(id: string): Promise<string | undefined> {
    return (await this.show(id))?.status;
  }

  /**
   * The per-sweep refresh (samskara-l2t.15): every bead of the copy in one
   * call, as a snapshot. Throws when bd fails or prints something that is not
   * a list, so a failed read is never taken for "no beads" or "no children".
   *
   * Why this call. Measured on bd 1.3.1 (Windows 11, embedded Dolt, a copy
   * holding 1,180 beads with 400-character descriptions, median of 5):
   *
   *   bd --version                                    146 ms
   *   bd --readonly show <id> --json                  609 ms
   *   bd --readonly list --parent=<id> --all ...      660 ms
   *   bd --readonly list --all --json -n 0            685 ms, 1.04 MB
   *   bd --readonly list --all --brief --json -n 0    686 ms, 0.67 MB
   *   bd --readonly list --id=<50 ids> --all ...      655 ms
   *   bd --readonly list --id=<1000 ids> --all ...    767 ms
   *
   * Process start and opening the database dominate, so one list of every
   * bead costs about what one `bd show` does, and it replaces the two reads
   * per container (show + list --parent) and one per other overview card the
   * sweep made before. `--id <carded ids>` (the design in the bead) is not
   * cheaper, cannot name the children an open-children count needs (they are
   * not carded: a closed child never is), and puts every id on the command
   * line, which Windows caps at 32,767 characters (CreateProcess).
   *
   * `--brief` drops the free-form text, which the sweep never needs (an
   * agent reads it with beads_show, samskara-l2t.8), and keeps the output well
   * under the runner's 32 MB buffer on a large repository. `--flat` is not
   * passed: with `--json` the tree is never built (bd v1.3.1
   * cmd/bd/list.go:265-285 returns before it), and both forms print the same
   * bytes. `-n 0` lifts the default limit of 50. `--include-gates` adds the
   * gate beads bd list otherwise hides (`bd list --help`), with their
   * `await_type` and parent (checked on bd 1.3.1), so a human gate is carded
   * for approval (samskara-l2t.9) and an open gate counts as an open child of
   * its molecule. The row cap
   * (`BEADS_MAX_ROWS`) cannot apply: the runner passes bd an allowlisted
   * environment without it (runner.ts).
   */
  async refresh(): Promise<BeadSnapshot> {
    const res = await this.runner.bd(['--readonly', 'list', '--all', '--brief', '--include-gates', '--json', '-n', '0'], { cwd: this.dir });
    if (res.code !== 0) throw new Error(`bd list --all failed (exit ${res.code}): ${tail(res)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout.trim() || '[]');
    } catch {
      throw new Error(`bd list --all printed no JSON: ${tail(res, 200)}`);
    }
    if (!Array.isArray(parsed)) throw new Error('bd list --all printed no list');
    return new BeadSnapshot((parsed as BeadRow[]).filter(row => typeof row?.id === 'string'));
  }

  /**
   * Close as the integration's actor. bd refuses to close a bead assigned to
   * anyone else ("assignee is X, actor is Y", bd v1.3.1
   * cmd/bd/show_unit_helpers.go:27-35), so a bead held by `holder` (as read by
   * the caller) is first handed over with bd's compare-and-swap reassign
   * (`--if-assignee`, exit 13 when the holder changed).
   *
   * The swap also takes over a live `in_progress` claim, which a plain
   * reassign refuses without `--force`: the owner decided a card reaching
   * Done closes its bead even while someone holds a claim (samskara-l2t.13).
   * `--force` itself is never passed, so bd's pinned, gate, open-child and
   * blocker refusals still stop the close; when one does, the bead is swapped
   * back to its holder so a refused close leaves no reassignment behind.
   */
  async close(id: string, reason: string, holder?: string): Promise<BdResult> {
    const actor = this.runner.actor;
    const handover = holder !== undefined && holder !== '' && holder !== actor;
    if (handover) {
      const swap = await this.runner.bd(
        ['--sandbox', '--actor', actor, 'update', id, `--assignee=${actor}`, `--if-assignee=${holder}`],
        { cwd: this.dir },
      );
      if (swap.code !== 0) return { ...swap, stderr: `handing ${id} over from "${holder}" failed: ${tail(swap)}` };
    }
    const closed = await this.runner.bd(['--sandbox', '--actor', actor, 'close', id, '--reason', reason], { cwd: this.dir });
    if (closed.code === 0 || !handover) return closed;
    const back = await this.runner.bd(
      ['--sandbox', '--actor', actor, 'update', id, `--assignee=${holder}`, `--if-assignee=${actor}`],
      { cwd: this.dir },
    );
    const note = back.code === 0 ? `returned to "${holder}"` : `NOT returned to "${holder}": ${tail(back, 200)}`;
    return { ...closed, stderr: `${tail(closed)} (bead ${note})` };
  }

  /**
   * Set the bead's status as the integration's actor, only if it is still
   * `expected`: bd's compare-and-swap (`--if-status`) writes nothing and exits
   * 13 when the status changed since the caller read it (bd update --help,
   * v1.3.1). A plain status update, never `--claim`: the assignee is left as
   * it is (samskara-l2t.4).
   */
  setStatus(id: string, status: string, expected: string): Promise<BdResult> {
    const actor = this.runner.actor;
    return this.runner.bd(['--sandbox', '--actor', actor, 'update', id, `--status=${status}`, `--if-status=${expected}`], {
      cwd: this.dir,
    });
  }

  /**
   * Wake every snoozed bead whose date has passed, with bd's own wake: a
   * writable `bd ready`. A defer with a date is a snooze, and "once --until
   * passes, the next ready-front read returns the issue to open
   * automatically (same shape as 'bd undefer')" (bd defer --help, v1.3.1);
   * a `--readonly` read never does, and every
   * read the sweep makes is read-only. Checked on bd 1.3.1: a bead deferred
   * until a past date reads `deferred` through `bd --readonly ready` and
   * `list`, and `open` after one writable `bd ready`; one deferred to a
   * future date, or with no date, stays deferred. bd decides what has
   * expired, on its own clock. Run as the integration's actor, the caller
   * holding the writer lease; the output is not read.
   */
  wake(): Promise<BdResult> {
    const actor = this.runner.actor;
    return this.runner.bd(['--sandbox', '--actor', actor, 'ready', '--brief', '--json', `--exclude-type=${NEVER_READY_TYPES.join(',')}`, '-n', '0'], {
      cwd: this.dir,
    });
  }

  /**
   * Evaluate the open gates and close the resolved ones, with bd's own check
   * (samskara-l2t.10): a timer once `created_at + timeout` has passed, a bead
   * gate once its bead is closed, a `gh:pr` gate once the PR is merged and a
   * `gh:run` gate once the run completed with success (bd gate check --help,
   * v1.3.1). GitHub gates are checked through the gh CLI, which gets the App
   * token as `GH_TOKEN` and finds the repository from the copy's origin.
   * Never `--escalate`: it shells out to Gas Town's `gt`. `-l 0` lifts the
   * default limit of 100 (checked on bd 1.3.1). bd prints a line per gate and
   * then the JSON summary; the summary is returned, or undefined when the
   * output has none. `type` limits the check to one gate type (`--type`);
   * omitted, every type is checked.
   */
  async checkGates(credentials: RepoCredentials | undefined, type?: string): Promise<{ res: BdResult; summary?: GateCheckSummary }> {
    const actor = this.runner.actor;
    const res = await this.runner.bd(
      ['--sandbox', '--actor', actor, 'gate', 'check', ...(type ? [`--type=${type}`] : []), '-l', '0', '--json'],
      // gh only runs for GitHub gates, so only an all-types check gets the token.
      { cwd: this.dir, credentials, github: !type },
    );
    const start = res.stdout.search(/^\{/m);
    if (start < 0) return { res };
    try {
      return { res, summary: JSON.parse(res.stdout.slice(start)) as GateCheckSummary };
    } catch {
      return { res };
    }
  }

  sync(credentials: RepoCredentials | undefined): Promise<BdResult> {
    return this.runner.bd(['sync'], { cwd: this.dir, credentials, timeoutMs: 300_000 });
  }
}

export { tail as resultTail };
