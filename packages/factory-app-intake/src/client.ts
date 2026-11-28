import type { ResolvedApp } from './apps';

/**
 * The two calls Factory makes to an outside app (samskara-rvq). Every app
 * serves the same contract, so adding one needs no code here:
 *
 *   GET  <baseUrl>/factory/tickets[?cursor=<c>]
 *        → 200 { "tickets": AppTicket[], "nextCursor": string | null }
 *        Only tickets a platform admin sent to Factory that are not fixed yet.
 *   POST <baseUrl>/factory/tickets/<id>/fixed
 *        body { "beadId", "reason", "closedAt" } → any 2xx. A repeat is harmless.
 *
 * Both carry `Authorization: Bearer <token>`. See docs/operations/app-intake.md.
 */
export interface AppTicket {
  /** The app's own ticket id. */
  id: string;
  /** A short summary that is safe to show in a public pull request. */
  title: string;
  /** e.g. `bug` or `idea`; becomes a bead label. */
  category?: string;
  page?: string;
  team?: string;
  description?: string;
  /** The failed run's step log, if there is one. */
  stepLog?: string;
  /** Link back to the ticket in the app. */
  url?: string;
  /** Changes when the ticket changes, so its bead is updated. */
  updatedAt?: string;
}

export interface FixedReport {
  beadId: string;
  reason: string;
  closedAt?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;

export class AppRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class AppClient {
  constructor(
    readonly app: ResolvedApp,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async listTickets(): Promise<AppTicket[]> {
    const tickets: AppTicket[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const body = (await this.#call('GET', `/factory/tickets${query}`)) as { tickets?: unknown; nextCursor?: unknown } | undefined;
      if (!body || !Array.isArray(body.tickets)) throw new AppRequestError(`${this.app.id}: ticket list has no "tickets" array`);
      for (const raw of body.tickets) {
        const ticket = toTicket(raw);
        if (ticket) tickets.push(ticket);
      }
      cursor = typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null;
      if (!cursor) return tickets;
    }
    throw new AppRequestError(`${this.app.id}: ticket list ran past ${MAX_PAGES} pages`);
  }

  async reportFixed(ticketId: string, report: FixedReport): Promise<void> {
    await this.#call('POST', `/factory/tickets/${encodeURIComponent(ticketId)}/fixed`, report);
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.app.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.app.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      throw new AppRequestError(`${this.app.id}: ${method} ${path.split('?')[0]} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) throw new AppRequestError(`${this.app.id}: ${method} ${path.split('?')[0]} answered ${res.status}`, res.status);
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      if (method === 'POST') return undefined;
      throw new AppRequestError(`${this.app.id}: ${method} ${path.split('?')[0]} answered with no JSON`);
    }
  }
}

const str = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/** A ticket as sent, or undefined when it has no usable id or title. */
export function toTicket(raw: unknown): AppTicket | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'number' ? String(r.id) : str(r.id, 200);
  const title = str(r.title, 200);
  if (!id || !title || !/^[A-Za-z0-9_.:-]+$/.test(id)) return undefined;
  return {
    id,
    title,
    category: str(r.category, 40)?.toLowerCase(),
    page: str(r.page, 500),
    team: str(r.team, 200),
    description: str(r.description, 6000),
    stepLog: str(r.stepLog, 20_000),
    url: str(r.url, 1000),
    updatedAt: str(r.updatedAt, 64),
  };
}
