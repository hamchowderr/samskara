/**
 * The app-intake hook against a REAL `bd` in a temp directory, with the app's
 * HTTP side replaced by an in-memory stand-in (samskara-rvq.2, rvq.3).
 * Skipped when `bd` is not on PATH (CI installs none); set
 * FACTORY_BEADS_REAL_BD=0 to skip it anyway.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BdRepo, BdRunner } from '@samskara/factory-beads';
import type { BeadsRepoHookContext } from '@samskara/factory-beads';

import { APP_TICKET_META, AppIntakeHook, beadDescription } from '../src/index';
import type { AppTicket, ResolvedApp } from '../src/index';

const bdAvailable = process.env.FACTORY_BEADS_REAL_BD !== '0' && spawnSync('bd', ['--version']).status === 0;

const APP: ResolvedApp = { id: 'demo', name: 'Demo support', baseUrl: 'https://demo.example', repo: 'acme/demo', tokenEnv: 'T', token: 'tok-123' };

/** The app's side of the contract, in memory. */
class StandIn {
  tickets: AppTicket[] = [];
  fixed: Array<{ id: string; body: unknown }> = [];
  failFixed = 0;
  failList = false;
  calls: Array<{ method: string; url: string; auth: string | null }> = [];

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    this.calls.push({ method, url, auth });
    if (auth !== `Bearer ${APP.token}`) return new Response('no', { status: 403 });
    const path = new URL(url).pathname;
    if (method === 'GET' && path === '/factory/tickets') {
      if (this.failList) return new Response('down', { status: 503 });
      const open = this.tickets.filter(t => !this.fixed.some(f => f.id === t.id));
      return Response.json({ tickets: open, nextCursor: null });
    }
    const m = /^\/factory\/tickets\/([^/]+)\/fixed$/.exec(path);
    if (method === 'POST' && m) {
      if (this.failFixed > 0) {
        this.failFixed--;
        return new Response('down', { status: 503 });
      }
      this.fixed.push({ id: decodeURIComponent(m[1]!), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }
    return new Response('?', { status: 404 });
  };
}

describe.skipIf(!bdAvailable)('AppIntakeHook with real bd', () => {
  let dir: string;
  let repo: BdRepo;
  let app: StandIn;
  let clock: number;
  let hook: AppIntakeHook;
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'app-intake-test-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('bd', ['init', '--prefix', 'demo', '-q'], { cwd: dir, env: { ...process.env, BEADS_ACTOR: 'test' } });
    repo = new BdRepo('acme/demo', dir, 'file:///unused', new BdRunner({ actor: 'factory-beads' }));
    app = new StandIn();
    clock = Date.parse('2026-11-28T12:00:00Z');
    hook = new AppIntakeHook({ apps: [APP], fetch: app.fetch, now: () => clock, pollIntervalMs: 0 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sweep = async () => {
    const ctx: BeadsRepoHookContext = { slug: 'acme/demo', snapshot: await repo.refresh(), bd: args => repo.write(args), log };
    return hook.run(ctx);
  };
  const appBeads = async () => [...(await repo.refresh()).values()].filter(b => b.metadata?.[APP_TICKET_META.app] === 'demo');

  it('applies only to the app repository', () => {
    expect(hook.appliesTo('acme/demo')).toBe(true);
    expect(hook.appliesTo('ACME/Demo')).toBe(true);
    expect(hook.appliesTo('acme/other')).toBe(false);
  });

  it('files one bead per ticket, once, and sends the token', async () => {
    app.tickets = [
      { id: 't1', title: 'Export button does nothing', category: 'bug', page: '/projects', stepLog: 'step 3 failed', url: 'https://demo.example/admin/t1', updatedAt: 'u1' },
      { id: 't2', title: 'Dark mode please', category: 'idea', updatedAt: 'u1' },
    ];
    expect(await sweep()).toEqual({ wrote: true });
    expect(await sweep()).toEqual({ wrote: false });
    const beads = await appBeads();
    expect(beads).toHaveLength(2);
    const bug = beads.find(b => b.metadata?.[APP_TICKET_META.id] === 't1')!;
    expect(bug.title).toBe('Export button does nothing');
    expect(bug.issue_type).toBe('bug');
    expect(bug.labels).toEqual(expect.arrayContaining(['app-ticket', 'app:demo', 'bug']));
    expect(beads.find(b => b.metadata?.[APP_TICKET_META.id] === 't2')!.issue_type).toBe('feature');
    expect(app.calls.every(c => c.auth === 'Bearer tok-123')).toBe(true);
    const shown = JSON.parse(execFileSync('bd', ['show', bug.id, '--json'], { cwd: dir, encoding: 'utf8' }));
    const full = Array.isArray(shown) ? shown[0] : shown;
    expect(full.description).toContain('step 3 failed');
    expect(full.external_ref).toBe('https://demo.example/admin/t1');
  });

  it('updates the bead when the ticket changes', async () => {
    app.tickets = [{ id: 't1', title: 'Old', updatedAt: 'u1' }];
    await sweep();
    app.tickets = [{ id: 't1', title: 'New title', updatedAt: 'u2' }];
    expect(await sweep()).toEqual({ wrote: true });
    const [bead] = await appBeads();
    expect(bead!.title).toBe('New title');
    expect(await appBeads()).toHaveLength(1);
  });

  it('reports fixed exactly once when the bead closes, and never refiles it', async () => {
    app.tickets = [{ id: 't1', title: 'Broken', updatedAt: 'u1' }];
    await sweep();
    const [bead] = await appBeads();
    execFileSync('bd', ['close', bead!.id, '--reason', 'Factory card c1 reached done'], { cwd: dir });
    expect(await sweep()).toEqual({ wrote: true });
    expect(app.fixed).toEqual([{ id: 't1', body: expect.objectContaining({ beadId: bead!.id, reason: 'Factory card c1 reached done' }) }]);
    await sweep();
    await sweep();
    expect(app.fixed).toHaveLength(1);
    expect(await appBeads()).toHaveLength(1);
    const [marked] = await appBeads();
    expect(marked!.metadata?.[APP_TICKET_META.fixedAt]).toBeDefined();
  });

  it('retries a failed fixed call with backoff', async () => {
    app.tickets = [{ id: 't1', title: 'Broken', updatedAt: 'u1' }];
    await sweep();
    const [bead] = await appBeads();
    execFileSync('bd', ['close', bead!.id, '--reason', 'done'], { cwd: dir });
    app.failFixed = 1;
    const first = await sweep();
    expect(first.failed).toBe(true);
    expect(first.diagnostic).toContain('503');
    // Inside the backoff window: not tried again.
    await sweep();
    expect(app.calls.filter(c => c.method === 'POST')).toHaveLength(1);
    clock += 61_000;
    expect((await sweep()).failed).toBeUndefined();
    expect(app.fixed).toHaveLength(1);
  });

  it('reports an app that is down without throwing', async () => {
    app.failList = true;
    const result = await sweep();
    expect(result).toEqual({ wrote: false, failed: true, diagnostic: expect.stringContaining('503') });
  });
});

describe('beadDescription', () => {
  it('warns about customer details and keeps the newest part of a long log within 8000 characters', () => {
    const text = beadDescription(APP, { id: 't9', title: 'x', description: 'report', stepLog: `${'a'.repeat(20_000)}END` });
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain('Privacy:');
    expect(text).toContain('END');
  });
});
