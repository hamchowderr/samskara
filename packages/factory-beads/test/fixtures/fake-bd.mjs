// A scripted stand-in for `bd`, run as `node fake-bd.mjs <bd args>`.
//
// State lives in the JSON file named by FAKE_BD_STATE: the beads (shared by
// every copy, like a remote that is always in sync), queued exit codes for
// `sync` and `dolt pull`, and a log of every call with its argv and the parts
// of its environment the tests assert on.
//
// The agent-tool commands (types, list, update, create, dep add, formula list,
// mol pour, init, dolt push) are modelled on bd 1.3.0's observed behaviour:
// `create --validate` refuses an unknown type and a type's missing sections
// (bd types --sections; the --acceptance field satisfies "Acceptance
// Criteria" and "Success Criteria"), and `mol pour` refuses missing
// required variables.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const statePath = process.env.FAKE_BD_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const argv = process.argv.slice(2);

state.calls.push({
  argv,
  cwd: process.cwd(),
  env: {
    token: process.env.BEADS_GIT_TOKEN ?? null,
    ghToken: process.env.GH_TOKEN ?? null,
    remoteInfoBranch: process.env.DOLT_REMOTE_INFO_BRANCH ?? null,
    // bd's usage-metrics switches, as runner.ts sets them.
    metrics: [process.env.BD_DISABLE_METRICS ?? null, process.env.BD_DISABLE_EVENT_FLUSH ?? null],
    gitConfig: Object.fromEntries(
      Array.from({ length: Number(process.env.GIT_CONFIG_COUNT ?? 0) }, (_, i) => [
        `${i}:${process.env[`GIT_CONFIG_KEY_${i}`]}`,
        process.env[`GIT_CONFIG_VALUE_${i}`],
      ]),
    ),
    // Must never leak from the server's environment into bd's.
    serverSecret: process.env.FAKE_SERVER_SECRET ?? null,
  },
});

const flags = argv.filter(a => a.startsWith('--'));
const words = [];
for (let i = 0; i < argv.length; i++) {
  if (['--actor', '--reason', '-n', '--author', '-f'].includes(argv[i])) {
    i++;
    continue;
  }
  if (!argv[i].startsWith('-')) words.push(argv[i]);
}
const reasonIndex = argv.indexOf('--reason');

let code = 0;
let out = '';
let err = '';
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const isOpen = bead => bead.status !== 'closed';
// Like bd 1.3.1 (checked): a bead is blocked by an open blocker of its own,
// and by one of any parent above it (an epic that depends on an unfinished
// task keeps its open child out of ready too).
const blocked = (bead, seen = new Set()) => {
  if (seen.has(bead.id)) return false;
  seen.add(bead.id);
  const own = (bead.blockedBy ?? []).some(id => {
    const blocker = state.beads.find(b => b.id === id);
    return blocker && isOpen(blocker);
  });
  if (own) return true;
  const parent = bead.parent ? state.beads.find(b => b.id === bead.parent) : undefined;
  return parent ? blocked(parent, seen) : false;
};

if (words.length === 0 && flags.includes('--version')) words.push('version');
if (words[0] === 'dolt' && words[1] === 'push') words[0] = 'dolt-push';
// Like bd 1.3.0, which refuses these under --readonly even with --dry-run
// ("operation 'pour' is not allowed in read-only mode").
const WRITES = { create: 'create', update: 'update', close: 'close', dep: 'dep add', mol: 'pour', init: 'init' };
if (flags.includes('--readonly') && WRITES[words[0]]) {
  state.calls.at(-1).refused = true;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stderr.write(`Error: operation '${WRITES[words[0]]}' is not allowed in read-only mode`);
  process.exit(1);
}

/** Value of `--name=value`, or undefined. */
const flagValue = name => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const flagValues = name => argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3));
const CORE_TYPES = ['task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone'];
const SECTIONS = {
  task: ['## Acceptance Criteria'],
  bug: ['## Steps to Reproduce', '## Acceptance Criteria'],
  feature: ['## Acceptance Criteria'],
  epic: ['## Success Criteria'],
  decision: ['## Decision', '## Rationale', '## Alternatives Considered'],
  spike: ['## Goal', '## Findings'],
  story: ['## Acceptance Criteria'],
};
// Fake formulas: { name, steps: [title], vars: [name], gated?, gateType? (default human), extends?: [name], hooks?: [name], user? }.
// A gated formula's first step carries the gate.
// `hooks` are kept as written, never applied: bd 1.3.0 cook and pour leave compose.hooks alone.
const composeOf = f => (f.hooks ? { compose: { hooks: f.hooks.map(attach => ({ trigger: 'label:security', attach })) } } : {});
const ownSteps = f => f.steps.map((title, i) => ({ id: `${f.name}.s${i}`, title, ...(f.gated && i === 0 ? { gate: { type: f.gateType ?? 'human' } } : {}) }));
const resolvedSteps = (f, seen = new Set()) => {
  seen.add(f.name);
  const parents = (f.extends ?? [])
    .map(name => (state.formulas ?? []).find(x => x.name === name))
    .filter(p => p && !seen.has(p.name));
  return [...parents.flatMap(p => resolvedSteps(p, seen)), ...ownSteps(f)];
};
const nextId = () => {
  state.seq = (state.seq ?? 0) + 1;
  return `${state.prefix ?? 'fake'}-${state.seq}`;
};

// Like bd 1.3.1: a writable ready read wakes every bead snoozed until a
// date that has passed (bd defer --help); a --readonly one never does.
if (words[0] === 'ready' && !flags.includes('--readonly')) {
  for (const b of state.beads) {
    if (b.status === 'deferred' && b.deferUntil && Date.parse(b.deferUntil) <= Date.now()) {
      b.status = 'open';
      delete b.deferUntil;
    }
  }
  // wakeFail: the wake commits, then the process exits non-zero (a timeout after the commit, say).
  if (state.wakeFail) {
    code = 1;
    err = 'Error: timed out';
  }
  save();
}

switch (words[0]) {
  case 'version':
    out = 'bd version 0.0.0-fake';
    break;
  case 'bootstrap':
    out = 'bootstrapped';
    break;
  case 'dolt':
    code = state.pullExits.length ? state.pullExits.shift() : 0;
    if (code) err = `pull failed; token was ${process.env.BEADS_GIT_TOKEN}`;
    break;
  case 'ready': {
    const excluded = flagValues('exclude-type').flatMap(v => v.split(','));
    // A bead with `repo` is listed only by that repository's copy, whose cache
    // directory is named after the slug (cacheDirFor in src/repo.ts).
    const inThisRepo = b => !b.repo || process.cwd().endsWith(b.repo.replace(/[^A-Za-z0-9._-]/g, '__'));
    const ready = state.beads.filter(
      // Like bd 1.3.1: only open beads are ready, so never a pinned
      // (sqlbuild/ready.go:117) or in_progress one, nor a molecule root, a gate
      // or a message (wisp) (:16-38). Event and decision beads it lists
      // (checked on bd 1.3.1); --exclude-type drops the rest.
      b =>
        inThisRepo(b) &&
        (b.status ?? 'open') === 'open' &&
        !['molecule', 'gate', 'message'].includes(b.issue_type) &&
        !blocked(b) &&
        !excluded.includes(b.issue_type),
    );
    // Like bd 1.3.0: --brief drops the free-form text, and an empty
    // description is omitted from the row either way.
    const brief = flags.includes('--brief');
    out = JSON.stringify(
      ready.map(({ id, title, status, priority, issue_type, description, parent }) => ({
        id,
        title,
        ...(!brief && description ? { description } : {}),
        status,
        priority,
        issue_type,
        // bd 1.3.1 names the parent-child edge's parent on the row.
        ...(parent ? { parent } : {}),
      })),
    );
    break;
  }
  case 'show': {
    const bead = state.beads.find(b => b.id === words[1]);
    if (!bead) {
      code = 1;
      err = 'not found';
    } else {
      // As bd 1.3.1 shows it: empty fields are omitted.
      const { id, title, status, priority, issue_type, assignee, parent, description, await_type } = bead;
      out = JSON.stringify([
        Object.fromEntries(
          Object.entries({ id, title, status, priority, issue_type, assignee, parent, description, await_type }).filter(([, v]) => v !== undefined && v !== ''),
        ),
      ]);
    }
    break;
  }
  case 'close': {
    const bead = state.beads.find(b => b.id === words[1]);
    const actor = argv.includes('--actor') ? argv[argv.indexOf('--actor') + 1] : 'someone';
    if (!bead || state.closeFail.includes(words[1])) {
      code = 1;
      err = `cannot close ${words[1]}`;
    } else if (bead.status === 'pinned' && !flags.includes('--force')) {
      code = 1;
      err = `cannot modify pinned issue ${words[1]} (use --force to override)`;
    } else if (state.beads.some(b => b.parent === bead.id && isOpen(b)) && !flags.includes('--force')) {
      // Like bd 1.3.1 (checked by hand, an epic and a task alike): no bead closes while a child is open.
      code = 1;
      err = `cannot close ${words[1]}: ${state.beads.filter(b => b.parent === bead.id && isOpen(b)).length} open child issue(s); close children first or use --force to override`;
    } else if (bead.assignee && bead.assignee !== actor && !flags.includes('--force')) {
      // Like bd 1.3.1 (validation.AssigneeMatches): only the holder may close.
      code = 1;
      err = `cannot close ${words[1]}: assignee is "${bead.assignee}", actor is "${actor}"; reclaim or use --force to override`;
    } else {
      bead.status = 'closed';
      bead.closeReason = reasonIndex >= 0 ? argv[reasonIndex + 1] : null;
      bead.updatedAt = new Date().toISOString();
      // Like bd 1.3.1 (checked by hand): closing a molecule's last open step
      // auto-closes the root ("Auto-closed completed molecule"). An epic is not.
      const root = state.beads.find(b => b.id === bead.parent);
      if (root?.issue_type === 'molecule' && isOpen(root) && state.beads.every(b => b.parent !== root.id || !isOpen(b))) {
        root.status = 'closed';
        root.closeReason = 'all steps complete';
      }
    }
    break;
  }
  case 'supersede':
  case 'duplicate': {
    // Like bd 1.3.1 (cmd/bd/duplicate.go:100-114, :170-184): add the edge,
    // then close with an EMPTY reason. `--with`/`--of` as `--with=X` or `--with X`.
    const name = words[0] === 'supersede' ? 'with' : 'of';
    const other = flagValue(name) ?? argv[argv.indexOf(`--${name}`) + 1];
    const bead = state.beads.find(b => b.id === words[1]);
    if (!bead || !state.beads.some(b => b.id === other) || other === words[1]) {
      code = 1;
      err = `failed to resolve ${words[1]}`;
      break;
    }
    if (words[0] === 'supersede') bead.supersededBy = other;
    else bead.duplicateOf = other;
    bead.status = 'closed';
    bead.closeReason = null;
    bead.updatedAt = new Date().toISOString();
    break;
  }
  case 'reopen': {
    // Like bd 1.3.1 (checked on a real copy): status open, close_reason and
    // closed_at cleared, a supersedes/duplicates edge kept.
    const bead = state.beads.find(b => b.id === words[1]);
    if (!bead) {
      code = 1;
      err = `issue ${words[1]} not found`;
      break;
    }
    bead.status = 'open';
    bead.closeReason = null;
    bead.updatedAt = new Date().toISOString();
    break;
  }
  case 'sync':
    code = state.syncExits.length ? state.syncExits.shift() : 0;
    if (code === 2) err = `CONFLICT in issues table; token was ${process.env.BEADS_GIT_TOKEN}`;
    if (code === 3) err = 'push race: retries exhausted';
    break;
  case 'dolt-push':
    // Publishes to the clone's origin the way bd does: a refs/dolt/data ref.
    if (state.pushFail) {
      code = 1;
      err = 'push rejected';
    } else {
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/dolt/data'], { stdio: 'ignore' });
      out = 'pushed';
    }
    break;
  case 'init':
    state.prefix = flagValue('prefix');
    state.inits = [...(state.inits ?? []), { prefix: state.prefix, cwd: process.cwd() }];
    out = 'initialized';
    break;
  case 'types':
    out = JSON.stringify({
      core_types: CORE_TYPES.map(name => ({ name })),
      ...(state.customTypes?.length ? { custom_types: state.customTypes } : {}),
      schema_version: 1,
    });
    break;
  case 'list': {
    const statuses = flagValue('status')?.split(',');
    const title = flagValue('title-contains')?.toLowerCase();
    // Like bd 1.3.1: --parent lists direct children only, --all adds closed ones.
    const parent = flagValue('parent');
    const all = flags.includes('--all');
    // Like bd 1.3.1: gates are hidden unless --include-gates (bd list --help).
    const gates = flags.includes('--include-gates');
    // listFail: every list without --parent fails (the refresh read), as many times as given (true: until cleared).
    if (parent === undefined && state.listFail) {
      if (typeof state.listFail === 'number') state.listFail--;
      code = 1;
      err = 'Error: database is locked';
      break;
    }
    const rows = state.beads.filter(
      b =>
        (statuses ? statuses.includes(b.status ?? 'open') : all || (b.status ?? 'open') !== 'closed') &&
        (gates || b.issue_type !== 'gate') &&
        // Like bd 1.3.1 (sqlbuild/filter.go:174-178): a dotted id with no parent-child edge is a child of each dotted prefix.
        (parent === undefined || b.parent === parent || (!b.parent && b.id.startsWith(`${parent}.`))) &&
        (!title || b.title.toLowerCase().includes(title)),
    );
    // As bd 1.3.1 prints a list row (checked on a real copy): empty fields
    // omitted, labels sorted, every edge in `dependencies`, `parent` from the
    // parent-child edge, and --brief dropping the description.
    const brief = flags.includes('--brief');
    out = JSON.stringify(
      rows.map(b => {
        const deps = [
          ...(b.parent ? [{ issue_id: b.id, depends_on_id: b.parent, type: 'parent-child' }] : []),
          ...(b.blockedBy ?? []).map(id => ({ issue_id: b.id, depends_on_id: id, type: 'blocks' })),
          ...(b.related ?? []).map(id => ({ issue_id: b.id, depends_on_id: id, type: 'related' })),
          // Like bd 1.3.1 (checked on a real copy): supersede and duplicate put
          // their edge on the closed bead's own row, and leave close_reason empty.
          ...(b.supersededBy ? [{ issue_id: b.id, depends_on_id: b.supersededBy, type: 'supersedes' }] : []),
          ...(b.duplicateOf ? [{ issue_id: b.id, depends_on_id: b.duplicateOf, type: 'duplicates' }] : []),
        ];
        const closed = (b.status ?? 'open') === 'closed';
        return Object.fromEntries(
          Object.entries({
            id: b.id,
            title: b.title,
            description: brief ? undefined : b.description,
            status: b.status ?? 'open',
            priority: b.priority ?? 2,
            issue_type: b.issue_type ?? 'task',
            await_type: b.await_type,
            await_id: b.await_id,
            timeout: b.timeout,
            defer_until: b.deferUntil,
            assignee: b.assignee,
            created_at: b.createdAt ?? '2026-01-01T00:00:00Z',
            updated_at: b.updatedAt ?? '2026-01-01T00:00:00Z',
            closed_at: closed ? (b.updatedAt ?? '2026-01-01T00:00:00Z') : undefined,
            close_reason: closed ? b.closeReason : undefined,
            labels: b.labels?.length ? [...b.labels].sort() : undefined,
            dependencies: deps.length ? deps : undefined,
            dependency_count: 0,
            dependent_count: 0,
            comment_count: b.comments?.length ?? b.commentCount ?? 0,
            parent: b.parent,
          }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
        );
      }),
    );
    break;
  }
  case 'update': {
    const bead = state.beads.find(b => b.id === words[1]);
    if (!bead) {
      code = 1;
      err = `issue ${words[1]} not found`;
      break;
    }
    // Like bd 1.3.1's compare-and-swap guards: checked before anything is
    // written, and a mismatch writes nothing and exits 13 (bd update --help).
    const expected = flagValue('if-assignee');
    // casFail: the holder (or status) changed after the caller read it.
    if (expected !== undefined && ((bead.assignee ?? '') !== expected || (state.casFail ?? []).includes(bead.id))) {
      code = 13;
      err = `assignee mismatch: ${bead.id} is held by "${bead.assignee ?? ''}", expected "${expected}"`;
      break;
    }
    const expectedStatus = flagValue('if-status');
    if (expectedStatus !== undefined && ((bead.status ?? 'open') !== expectedStatus || (state.casFail ?? []).includes(bead.id))) {
      code = 13;
      err = `status mismatch: ${bead.id} is ${bead.status ?? 'open'}, expected ${expectedStatus}`;
      break;
    }
    for (const [flag, field] of [
      ['title', 'title'],
      ['description', 'description'],
      ['design', 'design'],
      ['acceptance', 'acceptance_criteria'],
      ['status', 'status'],
    ]) {
      const value = flagValue(flag);
      if (value !== undefined) bead[field] = value;
    }
    if (flagValue('priority') !== undefined) bead.priority = Number(flagValue('priority'));
    // Like bd 1.3.1: --add-label and --remove-label are repeatable.
    const added = flagValues('add-label');
    const removed = flagValues('remove-label');
    if (added.length || removed.length) bead.labels = [...new Set([...(bead.labels ?? []), ...added])].filter(l => !removed.includes(l));
    // Like bd 1.3.1: a plain reassign of someone's live in_progress claim needs
    // --force; the compare-and-swap form (--if-assignee) takes it over.
    const next = flagValue('assignee');
    if (next !== undefined && expected === undefined && bead.status === 'in_progress' && bead.assignee && bead.assignee !== next && !flags.includes('--force')) {
      code = 1;
      err = `cannot reassign ${bead.id}: held by "${bead.assignee}" (in_progress); pass --force only if their claim is abandoned`;
      break;
    }
    if (next !== undefined) bead.assignee = next;
    bead.updatedAt = new Date().toISOString();
    const note = flagValue('append-notes');
    if (note !== undefined) bead.notes = bead.notes ? `${bead.notes}\n${note}` : note;
    out = JSON.stringify([bead]);
    break;
  }
  case 'create': {
    const type = flagValue('type') ?? 'task';
    const description = flagValue('description') ?? '';
    const acceptance = flagValue('acceptance');
    if (flags.includes('--validate')) {
      const allowed = [...CORE_TYPES, ...(state.customTypes ?? [])];
      if (!allowed.includes(type)) {
        code = 1;
        err = `Error: validation failed: validation failed for issue : invalid issue type: ${type}`;
        break;
      }
      const missing = (SECTIONS[type] ?? []).filter(
        s => !description.includes(s) && !(acceptance && (s === '## Acceptance Criteria' || s === '## Success Criteria')),
      );
      if (missing.length) {
        code = 1;
        err = `Error: missing required sections for ${type}:\n${missing.map(s => `  - ${s}`).join('\n')}`;
        break;
      }
    }
    const bead = {
      id: nextId(),
      title: flagValue('title'),
      status: 'open',
      priority: Number(flagValue('priority') ?? 2),
      issue_type: type,
      description,
      design: flagValue('design'),
      acceptance_criteria: acceptance,
      parent: flagValue('parent'),
      // Like bd 1.3.1: --labels is comma-separated.
      ...(flagValue('labels') ? { labels: flagValue('labels').split(',') } : {}),
    };
    state.beads.push(bead);
    out = JSON.stringify(bead);
    break;
  }
  case 'dep':
    if (words[1] !== 'add') {
      code = 64;
      err = `fake bd: unknown dep command ${words[1]}`;
      break;
    }
    state.deps = [...(state.deps ?? []), { issue: words[2], dependsOn: words[3], type: flagValue('type') ?? 'blocks' }];
    // A blocks edge (the default) keeps the issue out of ready, as in bd.
    if ((flagValue('type') ?? 'blocks') === 'blocks') {
      const issue = state.beads.find(b => b.id === words[2]);
      if (issue) issue.blockedBy = [...new Set([...(issue.blockedBy ?? []), words[3]])];
    }
    out = JSON.stringify({ issue_id: words[2], depends_on_id: words[3], status: 'added', type: flagValue('type') ?? 'blocks' });
    break;
  case 'cook': {
    // Resolved like bd cook: `extends` applied, parents' steps (and gates) first.
    const f = (state.formulas ?? []).find(x => x.name === words[1]);
    if (!f) {
      code = 1;
      err = `formula ${words[1]} not found`;
      break;
    }
    out = JSON.stringify({ formula: f.name, ...composeOf(f), steps: resolvedSteps(f) });
    break;
  }
  case 'formula': {
    // A formula with `user: true` lives in ~/.beads/formulas, outside the repository.
    const source = f => (f.user ? `/home/someone/.beads/formulas/${f.name}.formula.toml` : `${process.cwd()}/.beads/formulas/${f.name}.formula.toml`);
    // bd lists files that exist; the repository's must be real files (the tools resolve real paths).
    for (const f of state.formulas ?? []) {
      if (f.user || existsSync(source(f))) continue;
      mkdirSync(dirname(source(f)), { recursive: true });
      writeFileSync(source(f), `formula = "${f.name}"\n`);
    }
    if (words[1] === 'show') {
      const f = (state.formulas ?? []).find(x => x.name === words[2]);
      if (!f) {
        code = 1;
        err = `formula ${words[2]} not found`;
        break;
      }
      // As written: `extends` is listed, the parents' steps are not merged in.
      out = JSON.stringify({ formula: f.name, source: source(f), ...(f.extends ? { extends: f.extends } : {}), ...composeOf(f), steps: ownSteps(f) });
      break;
    }
    out = JSON.stringify(
      (state.formulas ?? []).map(f => ({ name: f.name, type: 'workflow', description: f.description, source: source(f), steps: f.steps.length, vars: f.vars.length })),
    );
    break;
  }
  case 'mol': {
    const formula = (state.formulas ?? []).find(f => f.name === words[2]);
    if (words[1] !== 'pour' || !formula) {
      code = 1;
      err = `formula ${words[2]} not found`;
      break;
    }
    const vars = Object.fromEntries(flagValues('var').map(v => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]));
    const missing = formula.vars.filter(v => !(v in vars));
    if (missing.length) {
      code = 1;
      out = JSON.stringify({ error: `missing required variables: ${missing.join(', ')}` });
      break;
    }
    const fill = text => text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
    if (flags.includes('--dry-run')) {
      out = JSON.stringify({ dry_run: true, steps: formula.steps.map(fill) });
      break;
    }
    // Like bd 1.3.1: the root is a molecule (checked with bd show on a poured root).
    const epic = { id: nextId(), title: fill(formula.name), status: 'open', issue_type: 'molecule' };
    state.beads.push(epic);
    const mapping = { [formula.name]: epic.id };
    let created = formula.steps.length + 1;
    for (const [i, step] of formula.steps.entries()) {
      const bead = { id: nextId(), title: fill(step), status: 'open', issue_type: 'task', parent: epic.id };
      // Like bd 1.3.1: a gated step gets a gate bead, titled `Gate: <type>`
      // under the root, that blocks it until closed.
      if (formula.gated && i === 0) {
        const type = formula.gateType ?? 'human';
        const gate = { id: nextId(), title: `Gate: ${type}`, status: 'open', issue_type: 'gate', await_type: type, parent: epic.id };
        state.beads.push(gate);
        mapping[`${formula.name}.gate-${step}`] = gate.id;
        bead.blockedBy = [gate.id];
        created++;
      }
      state.beads.push(bead);
      mapping[`${formula.name}.${step}`] = bead.id;
    }
    out = JSON.stringify({ created, id_mapping: mapping, new_epic_id: epic.id, phase: 'liquid' });
    break;
  }
  case 'gate': {
    // Like bd 1.3.1 gate check (bd gate check --help): a timer resolves once
    // created_at + timeout (ns) has passed, a bead gate once its bead is
    // closed, a GitHub gate when `ghMerged` names its await_id; `ghErrors`
    // names await_ids gh cannot read. A line per gate, then the JSON summary;
    // errors on stderr; exit 0.
    if (state.gateCheckFail) {
      code = 1;
      err = 'Error: database is locked';
      break;
    }
    if (words[1] !== 'check') {
      code = 1;
      err = `fake bd: gate ${words[1]} not supported`;
      break;
    }
    const lines = [];
    const errors = [];
    const summary = { checked: 0, dry_run: false, errors: 0, escalated: 0, resolved: 0, schema_version: 1 };
    // --type limits the check to one type, as bd's does.
    const only = flagValue('type');
    for (const g of state.beads.filter(
      b => b.issue_type === 'gate' && (b.status ?? 'open') === 'open' && b.await_type !== 'human' && (!only || b.await_type === only),
    )) {
      summary.checked++;
      let resolved = false;
      if (g.await_type === 'timer') {
        resolved = Date.parse(g.createdAt ?? '2026-01-01T00:00:00Z') + (g.timeout ?? 0) / 1e6 < Date.now();
      } else if (g.await_type === 'bead') {
        resolved = state.beads.find(b => b.id === g.await_id)?.status === 'closed';
      } else if (g.await_type === 'gh:pr' || g.await_type === 'gh:run') {
        if (!process.env.GH_TOKEN || (state.ghErrors ?? []).includes(g.await_id)) {
          summary.errors++;
          errors.push(`✗ ${g.id}: error checking - gh pr view failed`);
          continue;
        }
        if ((state.ghClosed ?? []).includes(g.await_id)) {
          summary.escalated++;
          lines.push(`⚠ ${g.id}: escalated - PR closed without merging`);
          continue;
        }
        resolved = (state.ghMerged ?? []).includes(g.await_id);
      }
      if (resolved) {
        g.status = 'closed';
        summary.resolved++;
        lines.push(`✓ ${g.id}: resolved`);
      } else {
        lines.push(`○ ${g.id}: pending`);
      }
    }
    out = [...lines, '', `Checked ${summary.checked} gates`, JSON.stringify(summary, null, 2)].join('\n');
    err = errors.join('\n');
    break;
  }
  case 'comments': {
    // bd 1.3.1: `comments <id> --json` lists them oldest first; `comments add
    // <id> <text>` adds one as the actor. Ids are content-derived UUIDs.
    const add = words[1] === 'add';
    const bead = state.beads.find(b => b.id === words[add ? 2 : 1]);
    if (!bead) {
      code = 1;
      err = `resolving ${words[add ? 2 : 1]}: no issue found`;
    } else if (add) {
      // `--author` (or the actor) names the author; `-f` reads the text from a file.
      const spaced = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
      const author = spaced('--author') ?? flagValue('author') ?? spaced('--actor') ?? flagValue('actor') ?? 'tester';
      const file = spaced('-f');
      const text = file !== undefined ? readFileSync(file, 'utf8') : words[3];
      // Like bd: the time of the write, in whole seconds (UTC).
      const created_at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000', '');
      const h = createHash('sha1').update(`${bead.id}|${author}|${text}|${created_at}`).digest('hex');
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      bead.comments = [...(bead.comments ?? []), { id, issue_id: bead.id, author, text, created_at }];
      out = JSON.stringify(bead.comments.at(-1));
    } else {
      out = JSON.stringify(bead.comments ?? []);
    }
    break;
  }
  default:
    code = 64;
    err = `fake bd: unknown command ${words[0]}`;
}

save();
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
process.exit(code);
