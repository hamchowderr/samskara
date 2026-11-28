import type { BeadSnapshot } from './repo';
import type { BdResult } from './runner';

/**
 * Extra work a sweep runs on one repository's bd copy, under the writer lease
 * the sweep already holds (samskara-rvq). It runs after write-back, the pull
 * and the snooze/gate step, and before intake reads ready beads, so a bead a
 * hook files is carded in the same sweep.
 *
 * A hook must not throw for an ordinary failure (an app that is down); it
 * returns `failed` and a diagnostic, and the sweep goes on. A throw is caught
 * and reported the same way.
 */
export interface BeadsRepoHook {
  /** Short name for logs and diagnostics. */
  readonly name: string;
  /** Whether the hook has anything to do for this repository (`owner/name`). */
  appliesTo(slug: string): boolean;
  run(ctx: BeadsRepoHookContext): Promise<BeadsRepoHookResult>;
}

export interface BeadsRepoHookContext {
  /** `owner/name` of the linked repository. */
  slug: string;
  /** Every bead in the copy, read after the sweep's last change. */
  snapshot: BeadSnapshot;
  /**
   * Run a bd WRITE on the copy as the integration's actor (`--sandbox
   * --actor <actor>` are added). Published by the sweep when the hook
   * reports `wrote`.
   */
  bd(args: readonly string[]): Promise<BdResult>;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface BeadsRepoHookResult {
  /** A write landed in the copy: the sweep publishes and reads the copy again. */
  wrote: boolean;
  /** Something failed; retried next sweep. */
  failed?: boolean;
  diagnostic?: string;
}
