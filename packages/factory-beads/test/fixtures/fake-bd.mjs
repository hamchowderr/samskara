// A scripted stand-in for `bd`, run as `node fake-bd.mjs <bd args>`.
//
// State lives in the JSON file named by FAKE_BD_STATE: the beads (shared by
// every copy, like a remote that is always in sync), queued exit codes for
// `sync` and `dolt pull`, and a log of every call with its argv and the parts
// of its environment the tests assert on.
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
    // A bead with `repo` is listed only by that repository's copy, whose cache
    // directory is named after the slug (cacheDirFor in src/repo.ts).
    const inThisRepo = b => !b.repo || process.cwd().endsWith(b.repo.replace(/[^A-Za-z0-9._-]/g, '__'));
    const ready = state.beads.filter(
      b => inThisRepo(b) && isOpen(b) && !blocked(b) && !(excludeEpic && b.issue_type === 'epic'),
    );
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
  default:
    code = 64;
    err = `fake bd: unknown command ${words[0]}`;
}

save();
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
process.exit(code);
