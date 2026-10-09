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
import { readFileSync, writeFileSync } from 'node:fs';

const statePath = process.env.FAKE_BD_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const argv = process.argv.slice(2);

state.calls.push({
  argv,
  cwd: process.cwd(),
  env: {
    token: process.env.BEADS_GIT_TOKEN ?? null,
    remoteInfoBranch: process.env.DOLT_REMOTE_INFO_BRANCH ?? null,
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
  if (argv[i] === '--actor' || argv[i] === '--reason' || argv[i] === '-n') {
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
const blocked = bead =>
  (bead.blockedBy ?? []).some(id => {
    const blocker = state.beads.find(b => b.id === id);
    return blocker && isOpen(blocker);
  });

if (words.length === 0 && flags.includes('--version')) words.push('version');
if (words[0] === 'dolt' && words[1] === 'push') words[0] = 'dolt-push';

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
const nextId = () => {
  state.seq = (state.seq ?? 0) + 1;
  return `${state.prefix ?? 'fake'}-${state.seq}`;
};

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
    const excludeEpic = flags.includes('--exclude-type=epic');
    const ready = state.beads.filter(b => isOpen(b) && !blocked(b) && !(excludeEpic && b.issue_type === 'epic'));
    // Like bd 1.3.0: --brief drops the free-form text, and an empty
    // description is omitted from the row either way.
    const brief = flags.includes('--brief');
    out = JSON.stringify(
      ready.map(({ id, title, status, priority, issue_type, description }) => ({
        id,
        title,
        ...(!brief && description ? { description } : {}),
        status,
        priority,
        issue_type,
      })),
    );
    break;
  }
  case 'show': {
    const bead = state.beads.find(b => b.id === words[1]);
    if (!bead) {
      code = 1;
      err = 'not found';
    } else out = JSON.stringify([{ id: bead.id, status: bead.status }]);
    break;
  }
  case 'close': {
    const bead = state.beads.find(b => b.id === words[1]);
    if (!bead || state.closeFail.includes(words[1])) {
      code = 1;
      err = `cannot close ${words[1]}`;
    } else {
      bead.status = 'closed';
      bead.closeReason = reasonIndex >= 0 ? argv[reasonIndex + 1] : null;
    }
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
    const rows = state.beads.filter(
      b =>
        (statuses ? statuses.includes(b.status ?? 'open') : (b.status ?? 'open') !== 'closed') &&
        (!title || b.title.toLowerCase().includes(title)),
    );
    out = JSON.stringify(rows.map(({ id, title, status, priority, issue_type }) => ({ id, title, status: status ?? 'open', priority, issue_type })));
    break;
  }
  case 'update': {
    const bead = state.beads.find(b => b.id === words[1]);
    if (!bead) {
      code = 1;
      err = `issue ${words[1]} not found`;
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
    out = JSON.stringify({ issue_id: words[2], depends_on_id: words[3], status: 'added', type: flagValue('type') ?? 'blocks' });
    break;
  case 'formula':
    out = JSON.stringify(
      (state.formulas ?? []).map(f => ({ name: f.name, type: 'workflow', description: f.description, source: `/srv/${f.name}.formula.toml`, steps: f.steps.length, vars: f.vars.length })),
    );
    break;
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
    const epic = { id: nextId(), title: fill(formula.name), status: 'open', issue_type: 'epic' };
    state.beads.push(epic);
    const mapping = { [formula.name]: epic.id };
    for (const step of formula.steps) {
      const bead = { id: nextId(), title: fill(step), status: 'open', issue_type: 'task', parent: epic.id };
      state.beads.push(bead);
      mapping[`${formula.name}.${step}`] = bead.id;
    }
    out = JSON.stringify({ created: formula.steps.length + 1, id_mapping: mapping, new_epic_id: epic.id, phase: 'liquid' });
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
