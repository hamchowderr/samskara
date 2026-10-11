/**
 * The beads agent tools (samskara-e64), against the scripted fake bd and a
 * real local git remote (harness.ts).
 */
import type { LeaseProvider } from '@mastra/core/events';
import type { RequestContext } from '@mastra/core/request-context';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BeadsSyncWorker, deferredAttachments, formulaReferences, isInside, LeaseWaitTimeoutError, unresolvedGate } from '../src/index';
import type { BeadsIntegration } from '../src/index';
import { createHarness, ORG, PROJECT, SLUG, sweep, TOKEN } from './harness';
import type { Harness } from './harness';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

class MemoryLease implements LeaseProvider {
  owners = new Map<string, string>();
  async acquireLease(key: string, owner: string) {
    const current = this.owners.get(key);
    if (current && current !== owner) return { acquired: false, owner: current };
    this.owners.set(key, owner);
    return { acquired: true, owner };
  }
  async getLeaseOwner(key: string) {
    return this.owners.get(key);
  }
  async releaseLease(key: string, owner: string) {
    if (this.owners.get(key) === owner) this.owners.delete(key);
  }
  async renewLease(key: string, owner: string) {
    return this.owners.get(key) === owner;
  }
  async transferLease(key: string, from: string, to: string) {
    if (this.owners.get(key) !== from) return false;
    this.owners.set(key, to);
    return true;
  }
}

/** The harness context has no projects.getById; Factory's storage does (projects/base.d.ts:52). */
function withGetById(harness: Harness): Harness {
  const projects = harness.ctx.storage.projects as unknown as { getById?: unknown };
  projects.getById = async ({ id }: { id: string }) => harness.sourceControl.projects.find(p => p.id === id) ?? null;
  return harness;
}

function requestContext(options: { projectId?: string; supervisor?: boolean; callerOrg?: string } = {}): RequestContext {
  const projectId = options.projectId ?? PROJECT;
  const controller = options.supervisor
    ? { resourceId: `factory-supervisor:${projectId}`, getState: () => ({}) }
    : { resourceId: 'session-1', getState: () => ({ factoryProjectId: projectId }) };
  const user = options.callerOrg ? { id: 'u1', organizationId: options.callerOrg } : undefined;
  return { get: (key: string) => (key === 'controller' ? controller : key === 'user' ? user : undefined) } as unknown as RequestContext;
}

type ToolResult = Record<string, unknown> & { error?: string };
type Tools = Record<string, { execute: (input: unknown, context?: unknown) => Promise<ToolResult> }>;

async function toolsFor(integration: BeadsIntegration, rc = requestContext()): Promise<Tools> {
  return (await integration.agentTools({ requestContext: rc })) as unknown as Tools;
}

/** Every bd call's argv, skipping the version probe. */
const bdCalls = (harness: Harness) => harness.state().calls.map(c => c.argv).filter(a => !a.includes('--version'));
const callsOf = (harness: Harness, command: string) => bdCalls(harness).filter(a => a.includes(command));

const GOOD = {
  title: 'Fix: auth token expires before refresh',
  type: 'bug',
  description: 'Tokens expire early, so users are logged out.\n\n## Steps to Reproduce\n1. Sign in\n2. Wait 59 minutes',
  design: 'Refresh at 80% of the lifetime; chose a timer over retry-on-401 because it avoids a failed request.',
  acceptance: 'A session that stays active is never logged out by token expiry.',
};

describe('agentTools', () => {
  const WORKER_TOOLS = [
    'beads_create',
    'beads_dep_add',
    'beads_formula_list',
    'beads_list',
    'beads_pour',
    'beads_ready',
    'beads_show',
    'beads_update',
  ];

  it('offers the tools, without beads_init and with no close or delete, to a worker session', async () => {
    h = withGetById(createHarness([]));
    const tools = await toolsFor(h.integration());
    expect(Object.keys(tools).sort()).toEqual(WORKER_TOOLS);
    expect(Object.keys(tools).some(name => /close|delete/.test(name))).toBe(false);
  });

  it('offers beads_init to the supervisor session only', async () => {
    h = withGetById(createHarness([]));
    const integration = h.integration();
    const supervisor = await toolsFor(integration, requestContext({ supervisor: true }));
    expect(Object.keys(supervisor).sort()).toEqual([...WORKER_TOOLS, 'beads_init'].sort());
    // A worker session of the same project, and a session whose resource id
    // only names the project, get no beads_init at all.
    expect(Object.keys(await toolsFor(integration))).not.toContain('beads_init');
    const byResource = {
      get: (key: string) => (key === 'controller' ? { resourceId: PROJECT, getState: () => ({}) } : undefined),
    } as unknown as RequestContext;
    expect(Object.keys(await toolsFor(integration, byResource))).not.toContain('beads_init');
  });

  it('a storage failure yields no beads tools instead of throwing, logged once', async () => {
    h = withGetById(createHarness([]));
    const warnings: string[] = [];
    const integration = h.integration({ logger: { info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined } });
    const handle = h.ctx.storage.sourceControls[0] as unknown as { connections: { list: () => Promise<unknown> } };
    handle.connections.list = async () => {
      throw new Error('database is locked');
    };
    expect(await toolsFor(integration)).toEqual({});
    expect(await toolsFor(integration, requestContext({ supervisor: true }))).toEqual({});
    expect(warnings.filter(w => w.includes('agent tools unavailable'))).toHaveLength(1);
    expect(warnings[0]).toMatch(/database is locked/);
  });

  it('offers nothing to a project with no linked repository, an unknown project, or another org', async () => {
    h = withGetById(createHarness([]));
    h.sourceControl.projects.push({ id: 'proj_empty', orgId: ORG });
    const integration = h.integration();
    expect(await toolsFor(integration, requestContext({ projectId: 'proj_empty' }))).toEqual({});
    expect(await toolsFor(integration, requestContext({ projectId: 'proj_missing' }))).toEqual({});
    expect(await toolsFor(integration, requestContext({ callerOrg: 'org_other' }))).toEqual({});
    expect(Object.keys(await toolsFor(integration, requestContext({ callerOrg: ORG })))).toContain('beads_ready');
  });

  it('resolves the supervisor session from its resource id', async () => {
    h = withGetById(createHarness([{ id: 'w-1', title: 'Ready one', issue_type: 'task' }]));
    const tools = await toolsFor(h.integration(), requestContext({ supervisor: true }));
    const result = await tools.beads_ready!.execute({});
    expect(result).toEqual({ repository: SLUG, beads: [expect.objectContaining({ id: 'w-1' })] });
  });
});

describe('reads', () => {
  it('run with --readonly and no token', async () => {
    h = withGetById(createHarness([{ id: 'w-1', title: 'One', issue_type: 'task' }]));
    const tools = await toolsFor(h.integration());
    await tools.beads_show!.execute({ id: 'w-1' });
    await tools.beads_list!.execute({ title_contains: 'one' });
    const reads = h.state().calls.filter(c => c.argv.includes('show') || c.argv.includes('list'));
    expect(reads).toHaveLength(2);
    for (const call of reads) {
      expect(call.argv).toContain('--readonly');
      expect(call.env.token).toBeNull();
    }
  });

  it('point at beads_init when origin has no beads data', async () => {
    h = withGetById(createHarness([]));
    h.setBeadsData(false);
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_ready!.execute({});
    expect(result.error).toMatch(/does not use beads yet.*beads_init/);
  });
});

describe('writes', () => {
  it('create passes --validate and the fields, under --sandbox, then bd sync with the token', async () => {
    h = withGetById(createHarness([]));
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_create!.execute({ ...GOOD, parent: 'w-9' });
    expect(result).toMatchObject({ repository: SLUG, published: true, result: { title: GOOD.title, issue_type: 'bug' } });
    const [create] = callsOf(h, 'create');
    expect(create).toEqual(
      expect.arrayContaining([
        '--sandbox',
        '--validate',
        `--title=${GOOD.title}`,
        '--type=bug',
        '--priority=2',
        `--design=${GOOD.design}`,
        `--acceptance=${GOOD.acceptance}`,
        '--parent=w-9',
      ]),
    );
    expect(create).toContain('factory-beads/agent');
    const calls = h.state().calls;
    const createIndex = calls.findIndex(c => c.argv.includes('create'));
    const sync = calls.findIndex((c, i) => i > createIndex && c.argv.includes('sync'));
    expect(sync).toBeGreaterThan(createIndex);
    expect(calls[sync]!.env.token).toBe(TOKEN);
    expect(calls[createIndex]!.env.token).toBeNull();
    // The token is never in argv.
    expect(calls.some(c => c.argv.some(a => a.includes(TOKEN)))).toBe(false);
  });

  it('create and update take labels; a label with a comma is refused before bd runs (samskara-l2t.5)', async () => {
    h = withGetById(createHarness([{ id: 'w-1', title: 'One', labels: ['old'] }]));
    const tools = await toolsFor(h.integration());
    expect(await tools.beads_create!.execute({ ...GOOD, labels: ['frontend', 'human'] })).toMatchObject({ published: true });
    expect(callsOf(h, 'create')[0]).toContain('--labels=frontend,human');
    expect(await tools.beads_update!.execute({ id: 'w-1', add_labels: ['api'], remove_labels: ['old'] })).toMatchObject({ published: true });
    expect(callsOf(h, 'update')[0]).toEqual(expect.arrayContaining(['--add-label=api', '--remove-label=old']));
    expect(h.state().beads.find(b => b.id === 'w-1')!.labels).toEqual(['api']);
    const parsed = (tools.beads_create as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } }).inputSchema.safeParse({
      ...GOOD,
      labels: ['a,b'],
    });
    expect(parsed.success).toBe(false);
  });

  it('create reports bd validation failures and writes nothing', async () => {
    h = withGetById(createHarness([]));
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_create!.execute({ ...GOOD, description: 'Broken. No reproduction steps.' });
    expect(result.error).toMatch(/missing required sections for bug[\s\S]*Steps to Reproduce/);
    expect(h.state().beads).toHaveLength(0);
    expect(callsOf(h, 'sync')).toHaveLength(0);
  });

  it('create rejects an unknown type before running bd create, naming the allowed types', async () => {
    h = withGetById(createHarness([]));
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_create!.execute({ ...GOOD, type: 'widget' });
    expect(result.error).toMatch(/"widget" is not an issue type.*bug, chore, decision, epic, feature, milestone, spike, story, task/);
    expect(callsOf(h, 'create')).toHaveLength(0);
  });

  it("create accepts bd's aliases and the repository's custom types", async () => {
    h = withGetById(createHarness([]));
    h.setState(s => Object.assign(s, { customTypes: ['research'] }));
    const tools = await toolsFor(h.integration());
    expect(await tools.beads_create!.execute({ ...GOOD, type: 'feat' })).toMatchObject({ result: { issue_type: 'feature' } });
    expect(await tools.beads_create!.execute({ ...GOOD, type: 'research' })).toMatchObject({ result: { issue_type: 'research' } });
  });

  it('update never closes: closed is refused and nothing reaches bd', async () => {
    h = withGetById(createHarness([{ id: 'w-1', title: 'One', issue_type: 'task' }]));
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_update!.execute({ id: 'w-1', status: 'closed' });
    expect(result.error).toMatch(/never close a bead.*Done/);
    expect(callsOf(h, 'update')).toHaveLength(0);
    expect(h.state().beads[0]!.status).toBeUndefined();
  });

  it('update appends notes and edits fields, never replacing notes', async () => {
    h = withGetById(createHarness([{ id: 'w-1', title: 'One', issue_type: 'task' }]));
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_update!.execute({ id: 'w-1', append_notes: 'found X', status: 'in_progress', priority: 1 });
    expect(result).toMatchObject({ published: true });
    const [update] = callsOf(h, 'update');
    expect(update).toEqual(expect.arrayContaining(['--append-notes=found X', '--status=in_progress', '--priority=1']));
    expect(update!.some(a => a.startsWith('--notes'))).toBe(false);
  });

  it('dep add links two beads with the given type', async () => {
    h = withGetById(createHarness([]));
    const tools = await toolsFor(h.integration());
    await tools.beads_dep_add!.execute({ issue: 'w-2', depends_on: 'w-1', type: 'discovered-from' });
    expect(h.state()).toMatchObject({ deps: [{ issue: 'w-2', dependsOn: 'w-1', type: 'discovered-from' }] });
  });

  it('a failed publish is reported, and the next sweep publishes it', async () => {
    h = withGetById(createHarness([]));
    h.setState(s => {
      s.syncExits = [1];
    });
    const integration = h.integration();
    const tools = await toolsFor(integration);
    const result = await tools.beads_create!.execute(GOOD);
    expect(result).toMatchObject({ published: false, warning: expect.stringMatching(/next sweep publishes it/) });
    const before = callsOf(h, 'sync').length;
    await sweep(integration);
    expect(callsOf(h, 'sync').length).toBe(before + 1);
    // Published: the sweep after that only pulls.
    await sweep(integration);
    expect(callsOf(h, 'sync').length).toBe(before + 1);
  });

  it('refuses writes to a parked repository', async () => {
    h = withGetById(createHarness([{ id: 'w-1', title: 'One', issue_type: 'task' }]));
    const integration = h.integration();
    await sweep(integration);
    const card = h.workItems.beadCards()[0]!;
    h.workItems.move(card.id, 'done');
    h.setState(s => {
      s.syncExits = [2];
    });
    await sweep(integration);
    const tools = await toolsFor(integration);
    const result = await tools.beads_update!.execute({ id: 'w-1', append_notes: 'x' });
    expect(result.error).toMatch(/parked/);
  });

  it('a sync conflict after a tool write parks the repository like a write-back conflict, until reset', async () => {
    h = withGetById(createHarness([{ id: 'w-1', title: 'One', issue_type: 'task' }]));
    const integration = h.integration();
    const tools = await toolsFor(integration);
    h.setState(s => {
      s.syncExits = [2];
    });
    const result = await tools.beads_update!.execute({ id: 'w-1', append_notes: 'x' });
    expect(result).toMatchObject({ published: false, warning: expect.stringMatching(/parked.*POST \/web\/beads\/reset/) });

    // The sweep reports it parked and neither pulls nor cards from the conflicted copy.
    h.setState(s => {
      s.beads.push({ id: 'w-2', title: 'Two', issue_type: 'task' });
    });
    const syncsBefore = callsOf(h, 'sync').length;
    const parked = await sweep(integration);
    expect(parked.repos[0]).toMatchObject({ state: 'parked', diagnostic: expect.stringMatching(/bd sync exit 2/) });
    expect(h.workItems.beadCards()).toHaveLength(0);
    expect(callsOf(h, 'sync').length).toBe(syncsBefore);
    // Tool writes are refused while parked; reads still work.
    expect((await tools.beads_update!.execute({ id: 'w-1', append_notes: 'y' })).error).toMatch(/parked/);
    expect((await tools.beads_show!.execute({ id: 'w-1' })).error).toBeUndefined();

    // The operator reset path: one flag, the copy is dropped, and syncing resumes.
    expect(await integration.requestReset(ORG, SLUG)).toEqual({ flagged: 1 });
    const after = await sweep(integration);
    expect(after.repos[0]).toMatchObject({ state: 'ok', created: 2 });
    expect(await tools.beads_update!.execute({ id: 'w-1', append_notes: 'z' })).toMatchObject({ published: true });
  });

  it('update never edits or reopens a closed bead', async () => {
    h = withGetById(createHarness([{ id: 'w-1', title: 'One', issue_type: 'task', status: 'closed' }]));
    const tools = await toolsFor(h.integration());
    for (const input of [{ status: 'open' }, { append_notes: 'more' }, { title: 'Renamed' }]) {
      const result = await tools.beads_update!.execute({ id: 'w-1', ...input });
      expect(result.error).toMatch(/w-1 is closed/);
    }
    expect(callsOf(h, 'update')).toHaveLength(0);
    expect(h.state().beads[0]!.status).toBe('closed');
  });
});

describe('repository argument', () => {
  const twoRepos = (harness: Harness) => {
    harness.sourceControl.repositories.set('repo_2', 'acme/gadgets');
    harness.sourceControl.connections[0]!.repositoryIds.push('repo_2');
    return harness;
  };

  it('is required, with the choices, when the project links several repositories', async () => {
    h = twoRepos(withGetById(createHarness([])));
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_ready!.execute({});
    expect(result.error).toMatch(/links 2 repositories; pass repository as one of: acme\/widgets, acme\/gadgets/);
  });

  it('targets the named repository, and rejects one that is not linked', async () => {
    h = twoRepos(withGetById(createHarness([])));
    const tools = await toolsFor(h.integration());
    const ok = await tools.beads_ready!.execute({ repository: 'acme/gadgets' });
    expect(ok).toMatchObject({ repository: 'acme/gadgets' });
    const ready = h.state().calls.filter(c => c.argv.includes('ready')).at(-1)!;
    expect(ready.cwd).toMatch(/acme__gadgets$/);
    const bad = await tools.beads_ready!.execute({ repository: 'acme/other' });
    expect(bad.error).toMatch(/not linked to this project/);
  });
});

describe('beads_init', () => {
  it('clones, runs bd init with the repository name, publishes refs/dolt/data, and hands over to the sweep', async () => {
    h = withGetById(createHarness([]));
    h.setBeadsData(false);
    const integration = h.integration();
    // The sweep has seen the repository without beads data.
    expect((await sweep(integration)).repos[0]!.state).toBe('no-beads-data');
    const tools = await toolsFor(integration, requestContext({ supervisor: true }));
    const result = await tools.beads_init!.execute({ confirm: true });
    expect(result).toEqual({ repository: SLUG, prefix: 'widgets', published: true });
    const [init] = callsOf(h, 'init');
    expect(init).toEqual(expect.arrayContaining(['--prefix=widgets', '--non-interactive', '--skip-agents', '--skip-hooks']));
    const push = h.state().calls.find(c => c.argv.includes('push'))!;
    expect(push.argv).toEqual(['dolt', 'push', '--yes']);
    expect(push.env.token).toBe(TOKEN);
    expect(push.env.remoteInfoBranch).toBe('');
    // The next sweep finds the data at once (no 15-minute wait) and bootstraps.
    expect((await sweep(integration)).repos[0]!.state).toBe('ok');
  });

  it('needs confirm: true', async () => {
    h = withGetById(createHarness([]));
    h.setBeadsData(false);
    const tools = await toolsFor(h.integration(), requestContext({ supervisor: true }));
    const result = await tools.beads_init!.execute({});
    expect(JSON.stringify(result)).toMatch(/confirm/);
    expect(callsOf(h, 'init')).toHaveLength(0);
  });

  it('is refused when the repository already uses beads', async () => {
    h = withGetById(createHarness([]));
    const tools = await toolsFor(h.integration(), requestContext({ supervisor: true }));
    const result = await tools.beads_init!.execute({ confirm: true });
    expect(result.error).toMatch(/already uses beads/);
    expect(callsOf(h, 'init')).toHaveLength(0);
  });
});

describe('workflows', () => {
  const formulas = [{ name: 'project', description: 'Internal project', vars: ['name', 'deliverable'], steps: ['Scope {{name}}', 'Build {{name}}'] }];

  it('formula list hides the server path', async () => {
    h = withGetById(createHarness([]));
    h.setState(s => Object.assign(s, { formulas }));
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_formula_list!.execute({});
    expect(result).toEqual({ repository: SLUG, formulas: [{ name: 'project', type: 'workflow', description: 'Internal project', steps: 2, vars: 2 }] });
  });

  it('pour passes each var, writes the molecule and publishes it', async () => {
    h = withGetById(createHarness([]));
    h.setState(s => Object.assign(s, { formulas }));
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_pour!.execute({ formula: 'project', vars: { name: 'auth', deliverable: 'login flow' } });
    expect(result).toMatchObject({ published: true, result: { created: 3 } });
    const [pour] = callsOf(h, 'pour');
    expect(pour).toEqual(expect.arrayContaining(['--sandbox', 'mol', 'pour', 'project', '--var=name=auth', '--var=deliverable=login flow']));
    expect(h.state().beads.map(b => b.title)).toEqual(['project', 'Scope auth', 'Build auth']);
  });

  it('pour reports missing variables; dry_run writes nothing', async () => {
    h = withGetById(createHarness([]));
    h.setState(s => Object.assign(s, { formulas }));
    const tools = await toolsFor(h.integration());
    const missing = await tools.beads_pour!.execute({ formula: 'project', vars: { name: 'auth' } });
    expect(missing.error).toMatch(/missing required variables: deliverable/);
    const preview = await tools.beads_pour!.execute({ formula: 'project', vars: { name: 'a', deliverable: 'b' }, dry_run: true });
    expect(preview).toMatchObject({ preview: { dry_run: true } });
    // bd refuses pour under --readonly even with --dry-run, so the preview runs with --sandbox.
    const dry = callsOf(h, 'pour').at(-1)!;
    expect(dry).toEqual(expect.arrayContaining(['--sandbox', '--dry-run']));
    expect(dry).not.toContain('--readonly');
    expect(h.state().beads).toHaveLength(0);
    expect(callsOf(h, 'sync')).toHaveLength(0);
  });

  it("lists and pours only the repository's own formulas, never the server user's", async () => {
    h = withGetById(createHarness([]));
    h.setState(s => Object.assign(s, { formulas: [...formulas, { ...formulas[0]!, name: 'personal', user: true }] }));
    const tools = await toolsFor(h.integration());
    const listed = await tools.beads_formula_list!.execute({});
    expect((listed.formulas as Array<{ name: string }>).map(f => f.name)).toEqual(['project']);
    for (const dry_run of [false, true]) {
      const result = await tools.beads_pour!.execute({ formula: 'personal', vars: { name: 'a', deliverable: 'b' }, dry_run });
      expect(result.error).toMatch(/not one of this repository's formulas.*Available: project/);
    }
    expect(callsOf(h, 'pour')).toHaveLength(0);
  });

  it('refuses a formula with a gate nothing resolves, and pours one whose gates are human (samskara-l2t.9)', async () => {
    h = withGetById(createHarness([]));
    h.setState(s =>
      Object.assign(s, {
        formulas: [
          { ...formulas[0]!, name: 'timed', gated: true, gateType: 'timer' },
          { ...formulas[0]!, name: 'approved', gated: true },
        ],
      }),
    );
    const tools = await toolsFor(h.integration());
    const result = await tools.beads_pour!.execute({ formula: 'timed', vars: { name: 'a', deliverable: 'b' } });
    expect(result.error).toMatch(/has a timer gate/);
    expect(callsOf(h, 'pour')).toHaveLength(0);
    expect(await tools.beads_pour!.execute({ formula: 'approved', vars: { name: 'a', deliverable: 'b' } })).toMatchObject({ published: true });
    expect(h.state().beads.filter(b => b.issue_type === 'gate')).toMatchObject([{ title: 'Gate: human', status: 'open' }]);
  });

  it('unresolvedGate: names the first gate nothing resolves, at any depth (samskara-l2t.10)', () => {
    const resolvable = [
      { type: 'human' },
      { type: 'timer', timeout: '2h' },
      { type: 'bead', await_id: 'x-1' },
      { type: 'gh:pr', await_id: '{{pr}}' },
      { type: 'gh:run', await_id: '123' },
    ];
    expect(unresolvedGate({ steps: resolvable.map(gate => ({ gate })) })).toBeUndefined();
    expect(unresolvedGate({ steps: [{ gate: { type: 'human' } }, { children: [{ gate: { type: 'gh:pr' } }] }] })).toBe('gh:pr gate with no await_id');
    expect(unresolvedGate({ steps: [{ gate: { type: 'gh:run', id: 'ci.yml' } }] })).toBe('gh:run gate with no await_id');
    expect(unresolvedGate({ steps: [{ gate: { type: 'timer' } }] })).toBe('timer gate with no timeout');
    expect(unresolvedGate({ steps: [{ gate: { type: 'mail' } }] })).toBe('mail gate');
    // A GitHub gate on another host: gh has no token for it (samskara-l2t.20).
    expect(unresolvedGate({ steps: [{ gate: { type: 'gh:pr', await_id: '4', repo: 'ghe.example.com/acme/app' } }] })).toBe('gh:pr gate on ghe.example.com');
    expect(unresolvedGate({ steps: [{ gate: { type: 'gh:run', await_id: '9', repo: 'GitHub.com/acme/app' } }] })).toBeUndefined();
    expect(unresolvedGate({ steps: [{ gate: { type: 'gh:pr', await_id: '4', repo: 'acme/other' } }] })).toBeUndefined();
    expect(unresolvedGate({ steps: [{ gate: {} }] })).toBe('untyped gate');
  });

  it('refuses a gate inherited through extends, checked on the cooked formula', async () => {
    h = withGetById(createHarness([]));
    h.setState(s =>
      Object.assign(s, {
        formulas: [
          { ...formulas[0]!, name: 'parent', gated: true, gateType: 'gh:run' },
          { ...formulas[0]!, name: 'child', extends: ['parent'] },
        ],
      }),
    );
    const tools = await toolsFor(h.integration());
    for (const dry_run of [false, true]) {
      const result = await tools.beads_pour!.execute({ formula: 'child', vars: { name: 'a', deliverable: 'b' }, dry_run });
      expect(result.error).toMatch(/has a gh:run gate with no await_id \(its own or inherited\)/);
    }
    expect(callsOf(h, 'cook')).toHaveLength(2);
    expect(callsOf(h, 'pour')).toHaveLength(0);
  });

  it('refuses a formula that composes with one outside the repository, at any depth', async () => {
    h = withGetById(createHarness([]));
    h.setState(s =>
      Object.assign(s, {
        formulas: [
          { ...formulas[0]!, name: 'outside', user: true },
          { ...formulas[0]!, name: 'wrap', extends: ['outside'] },
          { ...formulas[0]!, name: 'outer', extends: ['wrap'] },
          { ...formulas[0]!, name: 'base' },
          { ...formulas[0]!, name: 'fine', extends: ['base'] },
        ],
      }),
    );
    const tools = await toolsFor(h.integration());
    expect((await tools.beads_pour!.execute({ formula: 'wrap', vars: { name: 'a', deliverable: 'b' } })).error).toMatch(
      /composes with "outside" \(through itself\)/,
    );
    expect((await tools.beads_pour!.execute({ formula: 'outer', vars: { name: 'a', deliverable: 'b' } })).error).toMatch(
      /"outer" composes with "outside" \(through "wrap"\)/,
    );
    expect(callsOf(h, 'pour')).toHaveLength(0);
    // Extending another of the repository's own formulas is fine.
    expect(await tools.beads_pour!.execute({ formula: 'fine', vars: { name: 'a', deliverable: 'b' } })).toMatchObject({ published: true });
  });

  it('fails closed on a hook that attaches a gated formula, though bd 1.3.0 does not apply hooks', async () => {
    h = withGetById(createHarness([]));
    h.setState(s =>
      Object.assign(s, {
        formulas: [
          { ...formulas[0]!, name: 'gated', gated: true, gateType: 'timer' },
          { ...formulas[0]!, name: 'plain' },
          { ...formulas[0]!, name: 'hooked', hooks: ['gated'] },
          { ...formulas[0]!, name: 'outer', extends: ['hooked'] },
          { ...formulas[0]!, name: 'safe', hooks: ['plain'] },
        ],
      }),
    );
    const tools = await toolsFor(h.integration());
    for (const dry_run of [false, true]) {
      const result = await tools.beads_pour!.execute({ formula: 'hooked', vars: { name: 'a', deliverable: 'b' }, dry_run });
      expect(result.error).toMatch(/"hooked" attaches "gated" \(a hook or on_complete in itself\), which has a timer gate/);
    }
    // Inherited through extends, the hook is still found on the formula that declares it.
    expect((await tools.beads_pour!.execute({ formula: 'outer', vars: { name: 'a', deliverable: 'b' } })).error).toMatch(
      /"outer" attaches "gated" \(a hook or on_complete in "hooked"\)/,
    );
    expect(callsOf(h, 'pour')).toHaveLength(0);
    // The attached formula was cooked on its own.
    expect(callsOf(h, 'cook').filter(argv => argv.includes('gated')).length).toBeGreaterThan(0);
    // A hook attaching an ungated formula of the repository's own is fine.
    expect(await tools.beads_pour!.execute({ formula: 'safe', vars: { name: 'a', deliverable: 'b' } })).toMatchObject({ published: true });
  });
});

describe('deferredAttachments', () => {
  it('finds hooks and on_complete bonds, at any depth, and nothing bd applies at cook time', () => {
    const formula = {
      extends: ['a'],
      compose: { aspects: ['b'], expand: [{ target: 'x', with: 'c' }], hooks: [{ trigger: 'label:z', attach: 'e' }, { trigger: 'type:bug', attach: 'f' }] },
      steps: [
        { id: 's1', title: 't', expand: 'g' },
        { id: 's2', title: 't', on_complete: { for_each: 'o', bond: 'h' } },
        { id: 's3', title: 't', children: [{ id: 'c1', title: 't', on_complete: { for_each: 'o', bond: 'i' } }] },
      ],
    };
    expect(deferredAttachments(formula).sort()).toEqual(['e', 'f', 'h', 'i']);
  });
});

describe('isInside', () => {
  it('compares real paths, so a symlink out of the repository is outside', () => {
    const root = mkdtempSync(join(tmpdir(), 'fbi-'));
    try {
      const repo = join(root, 'repo');
      const formulas = join(repo, '.beads', 'formulas');
      mkdirSync(formulas, { recursive: true });
      mkdirSync(join(root, 'outside'));
      writeFileSync(join(formulas, 'own.formula.toml'), 'formula = "own"\n');
      writeFileSync(join(root, 'outside', 'secret.formula.toml'), 'formula = "secret"\n');
      expect(isInside(repo, join(formulas, 'own.formula.toml'))).toBe(true);
      expect(isInside(repo, join(root, 'outside', 'secret.formula.toml'))).toBe(false);
      expect(isInside(repo, join(formulas, 'missing.formula.toml'))).toBe(false);
      expect(isInside(repo, repo)).toBe(false);
      let linked = true;
      try {
        // A file symlink to an absolute path, as git checks a committed one out on Linux,
        // and a symlinked directory ('junction' needs no privilege on Windows).
        symlinkSync(join(root, 'outside', 'secret.formula.toml'), join(formulas, 'link.formula.toml'), 'file');
        symlinkSync(join(root, 'outside'), join(repo, '.beads', 'linked-dir'), 'junction');
      } catch (error) {
        // Windows without Developer Mode cannot create file symlinks (EPERM); Linux CI always can.
        if (process.platform !== 'win32') throw error;
        linked = false;
      }
      if (linked) {
        expect(isInside(repo, join(formulas, 'link.formula.toml'))).toBe(false);
        expect(isInside(repo, join(repo, '.beads', 'linked-dir', 'secret.formula.toml'))).toBe(false);
        // A repository reached through a symlink still contains its own files.
        symlinkSync(repo, join(root, 'repo-link'), 'junction');
        expect(isInside(join(root, 'repo-link'), join(formulas, 'own.formula.toml'))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formulaReferences', () => {
  it("finds every composition field bd's formula schema has", () => {
    const formula = {
      extends: ['a'],
      compose: {
        aspects: ['b'],
        expand: [{ target: 'x', with: 'c' }],
        map: [{ select: 'y', with: 'd' }],
        hooks: [{ trigger: 'label:z', attach: 'e' }],
      },
      steps: [
        { id: 's1', title: 't', expand: 'f' },
        { id: 's2', title: 't', on_complete: { for_each: 'o', bond: 'g' } },
        { id: 's3', title: 't', children: [{ id: 'c1', title: 't', expand: 'h' }] },
        { id: 's4', title: 't', loop: { count: 2, body: [{ id: 'b1', title: 't', expand: 'i' }] } },
      ],
    };
    expect(formulaReferences(formula).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });
});

describe('the writer lease', () => {
  it('withLease waits while another process holds the lease, then runs', async () => {
    const lease = new MemoryLease();
    lease.owners.set('beads:writer', 'other-process');
    const worker = new BeadsSyncWorker({ name: 'beads-sync', leaseKey: 'beads:writer', intervalMs: 60_000, leaseProvider: lease, sweep: async () => 0 });
    let ranAt = 0;
    const run = worker.withLease(async () => (ranAt = Date.now()), { pollMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(ranAt).toBe(0);
    const releasedAt = Date.now();
    lease.owners.delete('beads:writer');
    await run;
    expect(ranAt).toBeGreaterThanOrEqual(releasedAt);
    // Released afterwards.
    expect(lease.owners.has('beads:writer')).toBe(false);
  });

  it('withLease gives up after its timeout', async () => {
    const lease = new MemoryLease();
    lease.owners.set('beads:writer', 'other-process');
    const worker = new BeadsSyncWorker({ name: 'beads-sync', leaseKey: 'beads:writer', intervalMs: 60_000, leaseProvider: lease, sweep: async () => 0 });
    await expect(worker.withLease(async () => 1, { timeoutMs: 30, pollMs: 5 })).rejects.toBeInstanceOf(LeaseWaitTimeoutError);
  });

  it('withLease gives up waiting behind a long in-process operation, and its function never runs', async () => {
    const worker = new BeadsSyncWorker({ name: 'beads-sync', leaseKey: 'beads:writer', intervalMs: 60_000, sweep: async () => 0 });
    let release!: () => void;
    const long = worker.withLease(() => new Promise<void>(resolve => (release = resolve)));
    let ran = false;
    const queued = worker.withLease(
      async () => {
        ran = true;
      },
      { timeoutMs: 30 },
    );
    await expect(queued).rejects.toThrow(/waited 0 s behind a sweep or another beads operation/);
    release();
    await long;
    // The queue moves on; the abandoned call was skipped, not run late.
    await worker.withLease(async () => undefined);
    expect(ran).toBe(false);
  });

  it('a sweep and a withLease call in one process never overlap, even on the no-op lease', async () => {
    let active = 0;
    let overlapped = false;
    const busy = async () => {
      active++;
      if (active > 1) overlapped = true;
      await new Promise(resolve => setTimeout(resolve, 20));
      active--;
    };
    const worker = new BeadsSyncWorker({ name: 'beads-sync', leaseKey: 'beads:writer', intervalMs: 60_000, sweep: busy });
    await Promise.all([worker.runNow(), worker.withLease(busy), worker.runNow(), worker.withLease(busy)]);
    expect(overlapped).toBe(false);
  });

  it('a tool waits for the lease held by another process before running bd', async () => {
    const lease = new MemoryLease();
    h = withGetById(createHarness([{ id: 'w-1', title: 'One', issue_type: 'task' }]));
    const integration = h.integration({ leaseProvider: lease, toolLeaseWait: { pollMs: 5 } });
    const tools = await toolsFor(integration);
    lease.owners.set('beads:writer', 'other-process');
    const pending = tools.beads_update!.execute({ id: 'w-1', append_notes: 'x' });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(callsOf(h, 'update')).toHaveLength(0);
    lease.owners.delete('beads:writer');
    expect(await pending).toMatchObject({ published: true });
    expect(callsOf(h, 'update')).toHaveLength(1);
  });

  it('a tool reports a clear error when the lease never frees', async () => {
    const lease = new MemoryLease();
    h = withGetById(createHarness([]));
    const integration = h.integration({ leaseProvider: lease, toolLeaseWait: { pollMs: 5, timeoutMs: 30 } });
    const tools = await toolsFor(integration);
    lease.owners.set('beads:writer', 'other-process');
    const result = await tools.beads_ready!.execute({});
    expect(result.error).toMatch(/beads:writer lease was held by another process/);
  });
});
