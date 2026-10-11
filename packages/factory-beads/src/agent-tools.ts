/**
 * The beads agent tools (samskara-e64): Factory agents, the supervisor
 * included, read and write beads through these instead of running bd.
 *
 * Wiring: `FactoryIntegration.agentTools({ requestContext })`
 * (@mastra/factory 0.20.0 dist/integrations/base.d.ts:208-215). The factory
 * merges every integration's result into ONE async `extraTools` provider that
 * serves every session, the supervisor's included (dist/factory.js:519-596;
 * the integration loop is :588-595). The project is resolved the way Linear's
 * tools do it (dist/integrations/linear/agent-tools.js:69-83): the
 * controller's `factoryProjectId` state, else its resource id. A supervisor's
 * resource id is `factory-supervisor:<projectId>` (dist/supervisor/session.js:4-16),
 * and hydrateSupervisorSession stamps `factoryProjectId` on its state (:42-60).
 *
 * The supervisor loads no skills (it has no workspace: dist/workspace.js:245-253
 * returns before building one), so the authoring rules a skill would carry are
 * in these descriptions too. The full version is the `factory-beads` Factory skill,
 * src/mastra/public/factory-skills/factory-beads/SKILL.md.
 *
 * There is no close and no delete. Moving a card to Done closes its bead.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { createTool } from '@mastra/core/tools';
import type { RequestContext } from '@mastra/core/request-context';
import { getFactoryAuthOrgId, getFactoryAuthUserFromContext } from '@mastra/factory/auth';
import type { IntegrationTools } from '@mastra/factory/integrations/base';
import type { FactoryProjectsStorage } from '@mastra/factory/storage/domains/projects/base';
import { parseSupervisorResourceId } from '@mastra/factory/supervisor/session';
import { z } from 'zod';

import type { BdRepo } from './repo';
import { BeadsToolError } from './tool-ops';
import type { BeadsToolOps, ToolRepo, WriteOutcome } from './tool-ops';

/** One project's linked repositories, as the tools see them. */
export interface ToolScope {
  orgId: string;
  projectId: string;
  /** The project's supervisor session. Only it gets `beads_init` (owner decision, samskara-e64). */
  supervisor: boolean;
  repos: Array<{ repositoryId: string; slug: string }>;
}

interface ControllerLike {
  resourceId?: string;
  getState?: () => { factoryProjectId?: string; factoryOrgId?: string } | undefined;
}

/**
 * The project a request belongs to, checked against the caller's org. Undefined
 * when the request is not a Factory session, the project does not exist, or the
 * caller's org (or the session's stamped org) is a different one.
 *
 * `supervisor` is true only for the project's supervisor session: its
 * resource id is `factory-supervisor:<projectId>` (dist/supervisor/session.js:4-16).
 * Worker (triage, plan, build, review) and channel sessions have other ids.
 */
export async function resolveToolProject(
  requestContext: RequestContext,
  projects: Pick<FactoryProjectsStorage, 'getById'>,
): Promise<{ orgId: string; projectId: string; supervisor: boolean } | undefined> {
  if (!requestContext || typeof requestContext.get !== 'function') return undefined;
  const controller = requestContext.get('controller') as ControllerLike | undefined;
  if (!controller) return undefined;
  const state = controller.getState?.() ?? {};
  const supervisorOf = parseSupervisorResourceId(controller.resourceId);
  const projectId = state.factoryProjectId ?? supervisorOf ?? controller.resourceId;
  if (!projectId) return undefined;
  const project = await projects.getById({ id: projectId }).catch(() => null);
  if (!project) return undefined;
  const callerOrg = getFactoryAuthOrgId(getFactoryAuthUserFromContext(requestContext));
  if (callerOrg && callerOrg !== project.orgId) return undefined;
  if (state.factoryOrgId && state.factoryOrgId !== project.orgId) return undefined;
  return { orgId: project.orgId, projectId: project.id, supervisor: supervisorOf !== null && supervisorOf === project.id };
}

/** Issue types bd always accepts, and the aliases it maps (bd create --help, bd types). */
export const CORE_ISSUE_TYPES = ['task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone'] as const;
export const ISSUE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  enhancement: 'feature',
  feat: 'feature',
  dec: 'decision',
  adr: 'decision',
};
/** Statuses an agent may set. `closed` is deliberately absent: Done closes. */
export const SETTABLE_STATUSES = ['open', 'in_progress', 'blocked', 'deferred'] as const;
/** `bd dep add --type` values (bd dep add --help). */
export const DEPENDENCY_TYPES = [
  'blocks',
  'tracks',
  'related',
  'parent-child',
  'discovered-from',
  'until',
  'caused-by',
  'validates',
  'relates-to',
  'supersedes',
] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** The issue types this repository accepts: bd's core types plus `types.custom`. */
export async function allowedIssueTypes(repo: BdRepo): Promise<Set<string>> {
  const res = await repo.runner.bd(['--readonly', 'types', '--json'], { cwd: repo.dir });
  const allowed = new Set<string>(CORE_ISSUE_TYPES);
  if (res.code !== 0) return allowed;
  try {
    const parsed = JSON.parse(res.stdout) as { core_types?: Array<{ name?: unknown }>; custom_types?: unknown[] };
    for (const row of parsed.core_types ?? []) if (typeof row?.name === 'string') allowed.add(row.name);
    for (const name of parsed.custom_types ?? []) if (typeof name === 'string') allowed.add(name);
  } catch {
    // bd's core list above still applies.
  }
  return allowed;
}

/** Canonical type for `raw`, or a BeadsToolError listing what the repository accepts. */
export function checkIssueType(raw: string, allowed: Set<string>): string {
  const lower = raw.trim().toLowerCase();
  const type = ISSUE_TYPE_ALIASES[lower] ?? lower;
  if (allowed.has(type)) return type;
  throw new BeadsToolError(
    `"${raw}" is not an issue type this repository accepts. Use one of: ${[...allowed].sort().join(', ')}. ` +
      'task = a unit of work; bug = something broken (description needs "## Steps to Reproduce"); feature = new capability; ' +
      'chore = maintenance; epic = container for children; decision = a recorded choice; spike = timeboxed investigation; ' +
      'story = user-facing slice; milestone = marks a set of issues done.',
  );
}

/** Rules every agent writing beads must follow. Short form of the beads Factory skill. */
export const BEADS_AUTHORING_RULES = [
  'Rules (from the owner; full version in the `factory-beads` skill):',
  '- Search first (beads_list with title_contains, beads_ready) so you never file a duplicate; link related work with beads_dep_add instead.',
  '- One deliverable per bead. Several deliverables = several beads, or an epic with children (parent).',
  '- Fill every field, each with its own job: title = specific and action-oriented; description = the problem and why it matters;',
  '  design = HOW and the trade-offs ("chose X over Y because ..."); acceptance = WHAT success looks like, each criterion a verifiable yes/no outcome, not steps.',
  '  Test: if you re-implemented it another way and a criterion stopped applying, it was design, not acceptance.',
  '- Types: task (default unit of work), bug (description must contain "## Steps to Reproduce"), feature, chore, epic (container; children use parent),',
  '  decision, spike, story, milestone. Priority 0 = highest ... 4 = lowest; 2 is normal.',
  '- Found work mid-task? Create it, then beads_dep_add type discovered-from to the bead you were working on.',
  '- No private names in beads: they are published with the repository. Name a private product or client by its role ("a reference app").',
  '- Never close or delete a bead: moving its card to Done closes it. Notes are appended, never replaced.',
  '- Commits for a bead: Conventional Commits, `type(scope): summary (<bead-id>)`, subject <= 50 chars, imperative; never push to main.',
].join('\n');

const repositoryArg = z
  .string()
  .optional()
  .describe('Linked repository as owner/name. Required when this project links more than one repository.');

function idArg(what: string) {
  return z.string().min(1).regex(ID_PATTERN, 'not a bead id').describe(what);
}

/**
 * A list of bd labels (samskara-l2t.5). bd parses `--labels` as comma-separated
 * values, so a label may not contain a comma or a double quote (bd 1.3.1:
 * "bare \" in non-quoted-field"); whitespace around one is not a label.
 */
function labelsArg(what: string) {
  return z
    .array(z.string().min(1).regex(/^[^,"\s][^,"]*$/, 'a label has no comma or double quote and does not start with a space').max(100))
    .max(20)
    .optional()
    .describe(what);
}

function failure(error: unknown): { error: string } {
  if (error instanceof BeadsToolError) return { error: error.message };
  return { error: `beads tool failed: ${error instanceof Error ? error.message : String(error)}` };
}

function written(outcome: WriteOutcome): Record<string, unknown> {
  return outcome.published
    ? { result: outcome.output, published: true }
    : { result: outcome.output, published: false, warning: outcome.publishNote };
}

/** Pick the target repository; a BeadsToolError names the choices when it is ambiguous or unknown. */
export function pickRepository(scope: ToolScope, repository: string | undefined): ToolRepo {
  const slugs = scope.repos.map(r => r.slug);
  if (repository) {
    const wanted = repository.trim().toLowerCase();
    const hit = scope.repos.find(r => r.slug.toLowerCase() === wanted);
    if (!hit) throw new BeadsToolError(`"${repository}" is not linked to this project. Linked: ${slugs.join(', ')}`);
    return { orgId: scope.orgId, projectId: scope.projectId, repositoryId: hit.repositoryId, slug: hit.slug };
  }
  if (scope.repos.length === 1) {
    const only = scope.repos[0]!;
    return { orgId: scope.orgId, projectId: scope.projectId, repositoryId: only.repositoryId, slug: only.slug };
  }
  throw new BeadsToolError(`this project links ${scope.repos.length} repositories; pass repository as one of: ${slugs.join(', ')}`);
}

/** Issue prefix for `bd init`: the repository's name, as bd wants a prefix. */
export function initPrefix(slug: string): string {
  const name = slug.split('/').pop() ?? slug;
  const prefix = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!prefix) throw new BeadsToolError(`cannot derive an issue prefix from "${slug}"`);
  return prefix;
}

/** The real path (every symlink and junction resolved), or undefined when it cannot be resolved. */
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return undefined;
  }
}

/**
 * True when `file` lies inside `dir` once both are resolved to REAL paths
 * (case-insensitive on Windows). Comparing path text is not enough: bd
 * reports a formula's `source` as the path it found, so a formula file
 * committed as a symlink to an absolute path, or a symlinked `.beads` or
 * `formulas` directory, reads as inside the repository while bd parses a file
 * from anywhere on the server. On Linux (production) git checks a committed
 * symlink out as a real symlink; Git for Windows does too when core.symlinks
 * is on. A path that cannot be resolved counts as outside.
 */
export function isInside(dir: string, file: string): boolean {
  const realDir = realPath(dir);
  const realFile = realPath(file);
  if (!realDir || !realFile) return false;
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(norm(realDir), norm(realFile));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The repository's own formulas. bd also searches `~/.beads/formulas/` of the
 * user the server runs as (bd formula list --help); on a developer machine
 * that is the owner's personal library, which must not be listed or poured
 * into any repository, client repositories included. bd ships no built-in
 * formulas (bd 1.3.0 lists only files from its search paths), so a formula
 * counts only when its `source` file is inside the repository's copy, real
 * paths compared (isInside), so a symlink out of the repository is refused.
 */
export async function repositoryFormulas(repo: BdRepo): Promise<Array<Record<string, unknown>>> {
  const res = await repo.runner.bd(['--readonly', 'formula', 'list', '--json'], { cwd: repo.dir });
  if (res.code !== 0) throw new BeadsToolError(`bd formula list failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-300)}`);
  let rows: unknown;
  try {
    rows = JSON.parse(res.stdout.trim() || '[]');
  } catch {
    throw new BeadsToolError('bd formula list did not return JSON');
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === 'object' && typeof (row as { source?: unknown }).source === 'string' && isInside(repo.dir, (row as { source: string }).source),
  );
}

/**
 * The first gate in a cooked formula that nothing here resolves, at any
 * depth, described for the refusal; undefined when every gate resolves. A
 * `human` gate is carded for a person to approve (samskara-l2t.9); the sweep
 * resolves the rest with `bd gate check` (samskara-l2t.10): a `timer` with a
 * `timeout`, and a `bead`, `gh:pr` or `gh:run` gate with the thing it waits
 * on (`await_id`). A `gh:run` gate with no run id would need
 * `bd gate discover`, which matches runs by the current branch and time and
 * says nothing on the host's copy; a `mail` gate, or one with no readable
 * type, has no check at all. A GitHub gate whose `repo` names another host
 * (`HOST/OWNER/REPO`, bd formula schema gate) is refused too
 * (samskara-l2t.20): gh reads `GH_TOKEN` for github.com only, and its own
 * config directory holds no other login (runner.ts), so it could not read it.
 */
/** The host a gate's `repo` names, when it is not github.com: `HOST/OWNER/REPO` (bd formula schema gate). */
function githubHost(repo: string): string | undefined {
  const parts = repo.trim().split('/');
  if (parts.length !== 3) return undefined;
  const host = parts[0]!.toLowerCase();
  return host === 'github.com' || host === 'www.github.com' ? undefined : host;
}

export function unresolvedGate(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = unresolvedGate(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'gate' && inner) {
      const { type, timeout, await_id, repo } = inner as { type?: unknown; timeout?: unknown; await_id?: unknown; repo?: unknown };
      const has = (field: unknown) => typeof field === 'string' && field !== '';
      if (type === 'human') continue;
      if (type === 'timer') {
        if (has(timeout)) continue;
        return 'timer gate with no timeout';
      }
      if (type === 'bead' || type === 'gh:pr' || type === 'gh:run') {
        if (!has(await_id)) return `${type} gate with no await_id`;
        const host = type !== 'bead' && typeof repo === 'string' ? githubHost(repo) : undefined;
        if (host) return `${type} gate on ${host}`;
        continue;
      }
      return `${typeof type === 'string' && type ? type : 'untyped'} gate`;
    }
    const found = unresolvedGate(inner);
    if (found) return found;
  }
  return undefined;
}

/**
 * Every formula name a formula refers to, from the fields bd composes with
 * (bd formula schema Formula, ComposeRules, ExpandRule, MapRule, Hook, Step,
 * OnCompleteSpec): `extends`, `compose.aspects`, `compose.expand[].with`,
 * `compose.map[].with`, `compose.hooks[].attach`, a step's `expand` and
 * `on_complete.bond`, at any depth (children, loop bodies). A reference built
 * from a variable cannot be checked, so it is returned as-is and refused.
 */
export function formulaReferences(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) formulaReferences(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [key, inner] of Object.entries(value)) {
    if ((key === 'extends' || key === 'aspects') && Array.isArray(inner)) {
      for (const name of inner) if (typeof name === 'string') out.push(name);
    } else if ((key === 'with' || key === 'attach' || key === 'bond' || key === 'expand') && typeof inner === 'string') {
      if (inner) out.push(inner);
    }
    formulaReferences(inner, out);
  }
  return out;
}

/**
 * Formulas a formula attaches LATER rather than at cook time:
 * `compose.hooks[].attach` and a step's `on_complete.bond`, at any depth.
 * bd 1.3.0 applies neither (`bd cook` returns the hooks unexpanded and
 * `mol pour` creates no bead for them), so `bd cook <name>` cannot show their
 * gates. They are declared "automatic attachments" (internal/formula/types.go
 * Hook) and wiring on_complete is an open bd issue (gastownhall/beads#3782),
 * so each one is cooked on its own and refused if it has a gate nothing resolves.
 */
export function deferredAttachments(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) deferredAttachments(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'hooks' && Array.isArray(inner)) {
      for (const hook of inner) {
        const attach = (hook as { attach?: unknown } | null)?.attach;
        if (typeof attach === 'string' && attach) out.push(attach);
      }
    } else if (key === 'on_complete' && inner && typeof inner === 'object') {
      const bond = (inner as { bond?: unknown }).bond;
      if (typeof bond === 'string' && bond) out.push(bond);
    }
    deferredAttachments(inner, out);
  }
  return out;
}

async function bdJson(repo: BdRepo, args: string[], what: string): Promise<unknown> {
  const res = await repo.runner.bd(['--readonly', ...args, '--json'], { cwd: repo.dir });
  if (res.code !== 0) throw new BeadsToolError(`bd ${what} failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-300)}`);
  try {
    return JSON.parse(res.stdout) as unknown;
  } catch {
    throw new BeadsToolError(`bd ${what} did not return JSON`);
  }
}

/**
 * Refuse a formula unless it, and every formula it composes with, is the
 * repository's own, and its RESOLVED form has no gate but human ones.
 *
 * - Composition is followed recursively through `bd formula show`, which
 *   gives each formula as written. `extends`, an expansion or an aspect can
 *   name a formula from the server user's `~/.beads/formulas` or `$GT_ROOT`,
 *   whose steps would then be poured into this repository.
 * - Gates are checked on `bd cook <name>` (bd cook --help: "outputs the
 *   resolved formula as JSON"), not on `formula show`: an inherited gated
 *   step appears only after `extends` is applied. A gate makes bd create a
 *   gate bead that blocks its step until closed (bd formula schema gate). A
 *   human gate is carded for a person to approve (samskara-l2t.9), and the
 *   sweep resolves timer, bead and GitHub gates with `bd gate check`
 *   (samskara-l2t.10), so those are allowed when they carry what the check
 *   needs (unresolvedGate). Any other gate is refused: no tool closes a bead,
 *   so a step behind it would never become ready.
 * - Hooks and on_complete bonds are not applied by `bd cook` or `mol pour` in
 *   bd 1.3.0, so their formulas are cooked one by one and refused on the same terms
 *   (deferredAttachments): a later bd that applies them must not bring a gate
 *   into a molecule these tools poured.
 */
export async function checkPourableFormula(repo: BdRepo, name: string): Promise<void> {
  const ownRows = await repositoryFormulas(repo);
  const own = new Set(ownRows.map(row => String(row.name)));
  if (!own.has(name)) {
    throw new BeadsToolError(
      `"${name}" is not one of this repository's formulas (its .beads/formulas). ${own.size ? `Available: ${[...own].join(', ')}` : 'It has none.'}`,
    );
  }
  const seen = new Set<string>([name]);
  const queue = [name];
  const deferred = new Map<string, string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const shown = await bdJson(repo, ['formula', 'show', current], 'formula show');
    for (const ref of deferredAttachments(shown)) if (!deferred.has(ref)) deferred.set(ref, current);
    for (const ref of formulaReferences(shown)) {
      if (!own.has(ref)) {
        throw new BeadsToolError(
          `"${name}" composes with "${ref}" (through ${current === name ? 'itself' : `"${current}"`}), which is not one of this repository's formulas. Only formulas in the repository's .beads/formulas can be poured.`,
        );
      }
      if (!seen.has(ref)) {
        seen.add(ref);
        queue.push(ref);
      }
    }
  }
  const gate = unresolvedGate(await bdJson(repo, ['cook', name], 'cook'));
  if (gate) {
    throw new BeadsToolError(
      `"${name}" has a ${gate} (its own or inherited). Nothing here resolves it: human gates become approval cards, and timer, bead, gh:pr and gh:run gates with their timeout or await_id are checked every sweep. Any other gate becomes a bead that only closing can clear, and no tool closes beads, so its step would never become ready. Ask a person to pour it.`,
    );
  }
  // Fail closed on what bd would attach later (hooks, on_complete): cook each
  // one alone. A formula that cannot be cooked alone is refused too.
  for (const [attached, via] of deferred) {
    const gate = unresolvedGate(await bdJson(repo, ['cook', attached], 'cook'));
    if (gate) {
      throw new BeadsToolError(
        `"${name}" attaches "${attached}" (a hook or on_complete in ${via === name ? 'itself' : `"${via}"`}), which has a ${gate}. Nothing here resolves it, and no tool closes beads. Ask a person to pour it.`,
      );
    }
  }
}

/** The tools for one project. Empty when the project links no repository. */
export function createBeadsTools(ops: BeadsToolOps, scope: ToolScope): IntegrationTools {
  if (scope.repos.length === 0) return {};
  const linked = scope.repos.map(r => r.slug).join(', ');
  const where = `Linked repositories: ${linked}.`;

  const beads_ready = createTool({
    id: 'beads_ready',
    description: `List ready beads (open, no open blockers) in a linked repository, highest priority first. Read-only. ${where}`,
    inputSchema: z.object({
      repository: repositoryArg,
      type: z.string().optional().describe('Only this issue type, e.g. task, bug, feature.'),
      parent: idArg('Only descendants of this epic.').optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum rows. Default 50.'),
    }),
    execute: async ({ repository, type, parent, limit }) => {
      try {
        const target = pickRepository(scope, repository);
        const args = ['ready', '-n', String(limit ?? 50)];
        if (type) args.push(`--type=${type}`);
        if (parent) args.push(`--parent=${parent}`);
        return { repository: target.slug, beads: await ops.read(target, args) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const beads_list = createTool({
    id: 'beads_list',
    description: `List beads in a linked repository with filters (status, type, parent, label, priority, title). Rows are brief: use beads_show for the full text. Read-only. ${where}`,
    inputSchema: z.object({
      repository: repositoryArg,
      status: z
        .array(z.enum(['open', 'in_progress', 'blocked', 'deferred', 'closed']))
        .optional()
        .describe('Only these statuses. Default: every status except closed.'),
      type: z.string().optional().describe('Only this issue type.'),
      parent: idArg('Only children of this bead (an epic).').optional(),
      label: z.array(z.string().min(1)).optional().describe('Only beads carrying ALL of these labels.'),
      priority: z.number().int().min(0).max(4).optional().describe('Only this priority (0 = highest).'),
      title_contains: z.string().min(1).optional().describe('Case-insensitive substring of the title. Use it to look for duplicates before creating.'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum rows. Default 50.'),
    }),
    execute: async ({ repository, status, type, parent, label, priority, title_contains, limit }) => {
      try {
        const target = pickRepository(scope, repository);
        const args = ['list', '--flat', '--brief', '-n', String(limit ?? 50)];
        if (status?.length) args.push(`--status=${status.join(',')}`);
        if (type) args.push(`--type=${type}`);
        if (parent) args.push(`--parent=${parent}`);
        for (const l of label ?? []) args.push(`--label=${l}`);
        if (priority !== undefined) args.push(`--priority=${priority}`);
        if (title_contains) args.push(`--title-contains=${title_contains}`);
        return { repository: target.slug, beads: await ops.read(target, args) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const beads_show = createTool({
    id: 'beads_show',
    description: `Show one bead in full: title, description, design, acceptance, notes, status, dependencies. Read-only. ${where}`,
    inputSchema: z.object({ repository: repositoryArg, id: idArg('The bead id, e.g. samskara-e64.') }),
    execute: async ({ repository, id }) => {
      try {
        const target = pickRepository(scope, repository);
        return { repository: target.slug, bead: await ops.read(target, ['show', id]) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const beads_update = createTool({
    id: 'beads_update',
    description:
      `Edit a bead: title, description, design, acceptance, priority, status (open, in_progress, blocked, deferred), labels, or append to its notes. ` +
      `It cannot close a bead (moving the card to Done does that), never edits or reopens a closed bead, and never replaces notes. Published to the repository immediately. ${where}\n\n${BEADS_AUTHORING_RULES}`,
    inputSchema: z.object({
      repository: repositoryArg,
      id: idArg('The bead to edit.'),
      title: z.string().min(1).optional(),
      description: z.string().min(1).optional().describe('Replaces the description: the problem and why it matters.'),
      design: z.string().min(1).optional().describe('Replaces the design: how, and the trade-offs.'),
      acceptance: z.string().min(1).optional().describe('Replaces the acceptance criteria: verifiable outcomes.'),
      priority: z.number().int().min(0).max(4).optional(),
      status: z.string().optional().describe('open, in_progress, blocked or deferred. Not closed.'),
      append_notes: z.string().min(1).optional().describe('Appended to the notes (running log, handoff). Never replaces them.'),
      add_labels: labelsArg('Labels to add, e.g. ["frontend"]. "human" flags the bead for a person to decide.'),
      remove_labels: labelsArg('Labels to remove.'),
    }),
    execute: async ({ repository, id, title, description, design, acceptance, priority, status, append_notes, add_labels, remove_labels }) => {
      try {
        const target = pickRepository(scope, repository);
        if (status !== undefined && !(SETTABLE_STATUSES as readonly string[]).includes(status)) {
          throw new BeadsToolError(
            status === 'closed'
              ? 'beads tools never close a bead: move its card to Done and the integration closes it'
              : `status must be one of ${SETTABLE_STATUSES.join(', ')}`,
          );
        }
        const args = ['update', id];
        if (title) args.push(`--title=${title}`);
        if (description) args.push(`--description=${description}`);
        if (design) args.push(`--design=${design}`);
        if (acceptance) args.push(`--acceptance=${acceptance}`);
        if (priority !== undefined) args.push(`--priority=${priority}`);
        if (status) args.push(`--status=${status}`);
        if (append_notes) args.push(`--append-notes=${append_notes}`);
        for (const label of add_labels ?? []) args.push(`--add-label=${label}`);
        for (const label of remove_labels ?? []) args.push(`--remove-label=${label}`);
        if (args.length === 2) throw new BeadsToolError('nothing to update: pass at least one field');
        const outcome = await ops.write(target, async repo => {
          // A closed bead is left alone: bd would reopen it on --status=open,
          // and its card stays Done with the close recorded, so card and bead
          // would disagree for good. File follow-up work as a new bead.
          if ((await repo.status(id)) === 'closed') {
            throw new BeadsToolError(`${id} is closed; beads tools do not edit or reopen closed beads. File follow-up work as a new bead and link it with beads_dep_add.`);
          }
          return args;
        });
        return { repository: target.slug, ...written(outcome) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const beads_create = createTool({
    id: 'beads_create',
    description:
      `Create a bead (issue) in a linked repository. bd validates it (--validate): a type's required sections must be present, ` +
      `and an unknown type is refused. It lands on the board's intake and waits for a person; it is published immediately. ${where}\n\n${BEADS_AUTHORING_RULES}`,
    inputSchema: z.object({
      repository: repositoryArg,
      title: z.string().min(1).describe('Specific and action-oriented, e.g. "Fix: auth token expires before refresh".'),
      type: z.string().min(1).describe('task, bug, feature, chore, epic, decision, spike, story or milestone (or a custom type the repository defines).'),
      priority: z.number().int().min(0).max(4).optional().describe('0 = highest ... 4 = lowest. Default 2.'),
      description: z.string().min(1).describe('The problem and why it matters. A bug also needs a "## Steps to Reproduce" section.'),
      design: z.string().min(1).describe('How, and the trade-offs: "chose X over Y because ...".'),
      acceptance: z
        .string()
        .min(1)
        .optional()
        .describe('What success looks like: verifiable yes/no outcomes, not steps. Required for task, bug, feature and story; the success criteria of an epic.'),
      parent: idArg('The epic this bead belongs to.').optional(),
      labels: labelsArg('Labels, e.g. ["frontend", "api"]. "human" flags the bead for a person to decide.'),
    }),
    execute: async ({ repository, title, type, priority, description, design, acceptance, parent, labels }) => {
      try {
        const target = pickRepository(scope, repository);
        const outcome = await ops.write(target, async repo => {
          const canonical = checkIssueType(type, await allowedIssueTypes(repo));
          const args = [
            'create',
            `--title=${title}`,
            `--type=${canonical}`,
            `--priority=${priority ?? 2}`,
            `--description=${description}`,
            `--design=${design}`,
            '--validate',
          ];
          if (acceptance) args.push(`--acceptance=${acceptance}`);
          if (parent) args.push(`--parent=${parent}`);
          if (labels?.length) args.push(`--labels=${labels.join(',')}`);
          return args;
        });
        return { repository: target.slug, ...written(outcome) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const beads_dep_add = createTool({
    id: 'beads_dep_add',
    description:
      `Add a dependency: "issue" depends on "depends_on". Type blocks (default) keeps issue out of the ready list until depends_on closes; ` +
      `discovered-from links work found while doing another bead; related/relates-to just link. ${where}`,
    inputSchema: z.object({
      repository: repositoryArg,
      issue: idArg('The bead that depends on the other.'),
      depends_on: idArg('The bead it depends on.'),
      type: z.enum(DEPENDENCY_TYPES).optional().describe('Default blocks.'),
    }),
    execute: async ({ repository, issue, depends_on, type }) => {
      try {
        const target = pickRepository(scope, repository);
        const args = ['dep', 'add', issue, depends_on, `--type=${type ?? 'blocks'}`];
        return { repository: target.slug, ...written(await ops.write(target, async () => args)) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const beads_formula_list = createTool({
    id: 'beads_formula_list',
    description:
      `List the repository's own workflow formulas (its .beads/formulas) for beads_pour: name, type, description, steps and variable count. ` +
      `Formulas from anywhere else on the server are never offered. Read-only. ${where}`,
    inputSchema: z.object({ repository: repositoryArg }),
    execute: async ({ repository }) => {
      try {
        const target = pickRepository(scope, repository);
        const rows = await ops.inspect(target, repositoryFormulas);
        // `source` is a path on the server; the agent has no use for it.
        const formulas = rows.map(({ source: _source, ...rest }) => rest);
        return { repository: target.slug, formulas };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const beads_pour = createTool({
    id: 'beads_pour',
    description:
      `Pour one of the repository's own workflow formulas (bd mol pour): create a molecule (a root bead of type molecule) and its linked, ` +
      `ordered step beads in one go, with the formula's variables filled in. Only formulas from beads_formula_list, and only when every ` +
      `formula they extend or compose with is one too. A human gate in it becomes an approval card a person moves to Done; timer, bead and GitHub ` +
      `gates with their timeout or await_id are resolved by the sync. A formula with any other gate, its own, inherited or attached by a hook, is ` +
      `refused, because nothing resolves it. Set dry_run to preview without writing. ` +
      `Poured steps skip create-time validation, so fill any missing design/acceptance with beads_update before work starts. ${where}`,
    inputSchema: z.object({
      repository: repositoryArg,
      formula: z.string().min(1).regex(NAME_PATTERN, 'not a formula name').describe('Formula name from beads_formula_list.'),
      vars: z.record(z.string(), z.string()).optional().describe('Formula variables, e.g. { "name": "auth", "deliverable": "..." }.'),
      assignee: z.string().min(1).optional().describe('Assign the root issue to this person or agent.'),
      dry_run: z.boolean().optional().describe('Preview what would be created; writes nothing.'),
    }),
    execute: async ({ repository, formula, vars, assignee, dry_run }) => {
      try {
        const target = pickRepository(scope, repository);
        const args = ['mol', 'pour', formula];
        for (const [key, value] of Object.entries(vars ?? {})) {
          if (!VAR_KEY_PATTERN.test(key)) throw new BeadsToolError(`"${key}" is not a valid variable name`);
          args.push(`--var=${key}=${value}`);
        }
        if (assignee) args.push(`--assignee=${assignee}`);
        const check = (repo: BdRepo) => checkPourableFormula(repo, formula);
        if (dry_run) {
          // Not --readonly: bd 1.3.0 refuses pour in read-only mode even with --dry-run.
          return { repository: target.slug, preview: await ops.read(target, [...args, '--dry-run'], { mode: 'dry-run', check }) };
        }
        const outcome = await ops.write(target, async repo => {
          await check(repo);
          return args;
        });
        return { repository: target.slug, ...written(outcome) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const beads_init = createTool({
    id: 'beads_init',
    description:
      `Supervisor only. Start beads in a linked repository that has none: runs bd init with the repository's name as the issue prefix and ` +
      `publishes the empty database to the repository's refs/dolt/data. It changes the repository on GitHub, so call it ONLY when a person has ` +
      `asked for beads in that repository, and set confirm to true. Refused when the repository already uses beads. ${where}`,
    inputSchema: z.object({
      repository: repositoryArg,
      confirm: z.literal(true).describe('true: a person asked to start beads in this repository.'),
    }),
    execute: async ({ repository }) => {
      try {
        const target = pickRepository(scope, repository);
        return await ops.init(target, initPrefix(target.slug));
      } catch (error) {
        return failure(error);
      }
    },
  });

  return {
    beads_ready,
    beads_list,
    beads_show,
    beads_update,
    beads_create,
    beads_dep_add,
    beads_formula_list,
    beads_pour,
    // Owner decision (samskara-e64): only the supervisor may start beads in a
    // repository. Other sessions never get the tool, not merely a refusal.
    ...(scope.supervisor ? { beads_init } : {}),
  } as unknown as IntegrationTools;
}
