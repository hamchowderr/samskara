import type { BeadRow, BeadsRepoHook, BeadsRepoHookContext, BeadsRepoHookResult } from '@samskara/factory-beads';

import type { ResolvedApp } from './apps';
import { AppClient } from './client';
import type { AppTicket, FetchLike } from './client';

/**
 * Bead metadata keys that tie a bead to the app ticket it was filed from
 * (samskara-rvq.2). bd keeps metadata in `bd list --brief --json`, so the
 * sweep's one snapshot read is enough to find them.
 */
export const APP_TICKET_META = {
  app: 'app_ticket_app',
  id: 'app_ticket_id',
  updated: 'app_ticket_updated',
  /** Set once the app accepted the "fixed" call (samskara-rvq.3). */
  fixedAt: 'app_ticket_fixed_at',
} as const;

/** The bead label every app-filed bead carries, plus `app:<id>`. */
export const APP_TICKET_LABEL = 'app-ticket';

const DESCRIPTION_MAX = 8000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

export interface AppIntakeHookOptions {
  apps: readonly ResolvedApp[];
  fetch?: FetchLike;
  /** How often each app's ticket list is read. Default 60 s. */
  pollIntervalMs?: number;
  now?: () => number;
}

/** Bead type for a ticket category: ideas become features, everything else a bug. */
export function beadTypeFor(category: string | undefined): 'bug' | 'feature' {
  return category === 'idea' || category === 'feature' ? 'feature' : 'bug';
}

/**
 * The bead description. The repository may be public, so the text tells the
 * agent to keep ticket detail out of pull requests and commits.
 */
export function beadDescription(app: ResolvedApp, ticket: AppTicket): string {
  const facts = [
    `From: ${app.name}, ticket ${ticket.id}`,
    ticket.url ? `Ticket: ${ticket.url}` : undefined,
    ticket.category ? `Category: ${ticket.category}` : undefined,
    ticket.page ? `Page: ${ticket.page}` : undefined,
    ticket.team ? `Team: ${ticket.team}` : undefined,
  ].filter(Boolean);
  const head = [
    facts.join('\n'),
    'Privacy: this text may hold customer details. In pull requests and commits use only the bead title and the ticket id.',
    ticket.description ? `## Report\n\n${ticket.description}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!ticket.stepLog) return head.slice(0, DESCRIPTION_MAX);
  const room = DESCRIPTION_MAX - head.length - 40;
  if (room <= 200) return head.slice(0, DESCRIPTION_MAX);
  const log = ticket.stepLog.length > room ? `…${ticket.stepLog.slice(-room)}` : ticket.stepLog;
  return `${head}\n\n## Failed run step log\n\n\`\`\`\n${log}\n\`\`\``;
}

function ticketOf(bead: BeadRow): { app: string; id: string } | undefined {
  const app = bead.metadata?.[APP_TICKET_META.app];
  const id = bead.metadata?.[APP_TICKET_META.id];
  if (app === undefined || id === undefined) return undefined;
  return { app: String(app), id: String(id) };
}

/**
 * Files each approved app ticket as a bead in the app's repository, and tells
 * the app "fixed" when that bead closes (samskara-rvq.2, rvq.3). Runs inside
 * the beads sweep, under its writer lease; the beads integration then cards the
 * bead and closes it when its card reaches Done.
 *
 * Idempotent: a bead is found by its metadata, so a ticket listed again is
 * never filed twice, and a closed bead is never filed again. The fixed call is
 * repeated, with backoff, until the app accepts it; the acceptance is then
 * written on the bead, so a restart does not send it again.
 */
export class AppIntakeHook implements BeadsRepoHook {
  readonly name = 'app-intake';
  readonly #apps: readonly ResolvedApp[];
  readonly #clients = new Map<string, AppClient>();
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #lastPoll = new Map<string, number>();
  readonly #retryAt = new Map<string, { at: number; delay: number }>();

  constructor(options: AppIntakeHookOptions) {
    this.#apps = options.apps;
    this.#pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    for (const app of options.apps) this.#clients.set(app.id, new AppClient(app, options.fetch));
  }

  appliesTo(slug: string): boolean {
    return this.#apps.some(app => app.repo.toLowerCase() === slug.toLowerCase());
  }

  async run(ctx: BeadsRepoHookContext): Promise<BeadsRepoHookResult> {
    const apps = this.#apps.filter(app => app.repo.toLowerCase() === ctx.slug.toLowerCase());
    let wrote = false;
    const problems: string[] = [];
    for (const app of apps) {
      const client = this.#clients.get(app.id)!;
      const beads = new Map<string, BeadRow>();
      for (const bead of ctx.snapshot.values()) {
        const ref = ticketOf(bead);
        if (ref?.app === app.id) beads.set(ref.id, bead);
      }

      // rvq.3 first: report closed beads, so a ticket fixed this sweep drops
      // off the app's list before the list is read.
      for (const [ticketId, bead] of beads) {
        if (bead.status !== 'closed' || bead.metadata?.[APP_TICKET_META.fixedAt] !== undefined) continue;
        const key = `${app.id}:${ticketId}`;
        const retry = this.#retryAt.get(key);
        if (retry && this.#now() < retry.at) continue;
        try {
          await client.reportFixed(ticketId, {
            beadId: bead.id,
            reason: bead.close_reason ?? 'closed',
            ...(bead.closed_at ? { closedAt: bead.closed_at } : {}),
          });
        } catch (error) {
          const delay = Math.min((retry?.delay ?? RETRY_BASE_MS / 2) * 2, RETRY_MAX_MS);
          this.#retryAt.set(key, { at: this.#now() + delay, delay });
          problems.push(error instanceof Error ? error.message : String(error));
          continue;
        }
        this.#retryAt.delete(key);
        const mark = await ctx.bd(['update', bead.id, '--set-metadata', `${APP_TICKET_META.fixedAt}=${new Date(this.#now()).toISOString()}`]);
        if (mark.code !== 0) {
          problems.push(`${app.id}: ${bead.id} reported fixed but not marked (bd exit ${mark.code}); it is reported again next sweep`);
          continue;
        }
        wrote = true;
        ctx.log.info(`[app-intake] ${app.id}: ticket ${ticketId} reported fixed (bead ${bead.id})`);
      }

      // rvq.2: file or update one bead per approved ticket.
      const last = this.#lastPoll.get(app.id);
      if (last !== undefined && this.#now() - last < this.#pollIntervalMs) continue;
      let tickets: AppTicket[];
      try {
        tickets = await client.listTickets();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      this.#lastPoll.set(app.id, this.#now());
      for (const ticket of tickets) {
        const bead = beads.get(ticket.id);
        const updated = ticket.updatedAt ?? '';
        if (bead) {
          if (bead.status === 'closed' || String(bead.metadata?.[APP_TICKET_META.updated] ?? '') === updated) continue;
          const res = await ctx.bd([
            'update', bead.id,
            '--title', ticket.title,
            '--description', beadDescription(app, ticket),
            '--set-metadata', `${APP_TICKET_META.updated}=${updated}`,
          ]);
          if (res.code !== 0) problems.push(`${app.id}: ticket ${ticket.id} not updated on ${bead.id} (bd exit ${res.code})`);
          else wrote = true;
          continue;
        }
        const labels = [APP_TICKET_LABEL, `app:${app.id}`, ...(ticket.category ? [ticket.category] : [])];
        const metadata = { [APP_TICKET_META.app]: app.id, [APP_TICKET_META.id]: ticket.id, [APP_TICKET_META.updated]: updated };
        const res = await ctx.bd([
          'create',
          '--title', ticket.title,
          '--type', beadTypeFor(ticket.category),
          '--priority', '2',
          '--description', beadDescription(app, ticket),
          '--labels', labels.join(','),
          ...(ticket.url ? ['--external-ref', ticket.url] : []),
          '--metadata', JSON.stringify(metadata),
          '--silent',
        ]);
        if (res.code !== 0) {
          problems.push(`${app.id}: ticket ${ticket.id} not filed (bd exit ${res.code})`);
          continue;
        }
        wrote = true;
        ctx.log.info(`[app-intake] ${app.id}: ticket ${ticket.id} filed as ${res.stdout.trim() || 'a bead'}`);
      }
    }
    return problems.length > 0 ? { wrote, failed: true, diagnostic: problems.join('; ') } : { wrote };
  }
}
