/**
 * Which outside apps send tickets, read from `APP_INTAKE_APPS` (samskara-rvq.1).
 *
 * The variable holds a JSON array, one entry per app:
 *
 *   [{"id":"takewon","name":"Takewon support","baseUrl":"https://…","repo":"owner/name","tokenEnv":"APP_INTAKE_TAKEWON_TOKEN"}]
 *
 * The token itself is never in that JSON: `tokenEnv` names the variable that
 * holds it, so the list can be shown or logged and the secret cannot. An app
 * whose token variable is empty is left out with one log line; a malformed
 * list leaves every app out and never stops the server from starting.
 */
export interface AppConfig {
  /** Short stable id, `[a-z0-9-]`. Written on every bead the app files. */
  id: string;
  /** Shown in logs and on bead descriptions, e.g. "Takewon support". */
  name: string;
  /** Where the app serves the three endpoints, without a trailing slash. */
  baseUrl: string;
  /** The linked repository (`owner/name`) whose beads hold this app's tickets. */
  repo: string;
  /** The env var holding the token Factory sends to the app. */
  tokenEnv: string;
}

export interface ResolvedApp extends AppConfig {
  token: string;
}

export interface AppsResult {
  apps: ResolvedApp[];
  /** One line per app left out or per problem, for the startup log. Never contains a token. */
  problems: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;

export function appsFromEnv(env: NodeJS.ProcessEnv = process.env): AppsResult {
  const raw = env.APP_INTAKE_APPS?.trim();
  if (!raw) return { apps: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { apps: [], problems: ['APP_INTAKE_APPS is not valid JSON; no outside app is read'] };
  }
  if (!Array.isArray(parsed)) return { apps: [], problems: ['APP_INTAKE_APPS must be a JSON array; no outside app is read'] };
  const apps: ResolvedApp[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const where = `APP_INTAKE_APPS[${index}]`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${where} is not an object; left out`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : id;
    const baseUrl = typeof e.baseUrl === 'string' ? e.baseUrl.trim().replace(/\/+$/, '') : '';
    const repo = typeof e.repo === 'string' ? e.repo.trim() : '';
    const tokenEnv = typeof e.tokenEnv === 'string' ? e.tokenEnv.trim() : '';
    if (!ID_RE.test(id)) {
      problems.push(`${where}: id must be lower-case letters, digits and dashes; left out`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${where}: id "${id}" is listed twice; the second is left out`);
      continue;
    }
    let url: URL | undefined;
    try {
      url = new URL(baseUrl);
    } catch {
      url = undefined;
    }
    if (!url || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      problems.push(`${where} (${id}): baseUrl must be an https URL; left out`);
      continue;
    }
    if (!REPO_RE.test(repo)) {
      problems.push(`${where} (${id}): repo must be owner/name; left out`);
      continue;
    }
    if (!ENV_RE.test(tokenEnv)) {
      problems.push(`${where} (${id}): tokenEnv must name an env var (A-Z, 0-9, _); left out`);
      continue;
    }
    const token = env[tokenEnv]?.trim();
    if (!token) {
      problems.push(`${id}: ${tokenEnv} is not set; app left out`);
      continue;
    }
    seen.add(id);
    apps.push({ id, name, baseUrl, repo, tokenEnv, token });
  }
  return { apps, problems };
}

/** The startup line: which apps are read, without tokens. */
export function appsStartupLine(result: AppsResult): string {
  if (result.apps.length === 0 && result.problems.length === 0) return '[app-intake] off: APP_INTAKE_APPS is not set';
  const on = result.apps.map(app => `${app.id} -> ${app.repo}`).join(', ') || 'none';
  const problems = result.problems.length > 0 ? `; ${result.problems.join('; ')}` : '';
  return `[app-intake] apps: ${on}${problems}`;
}
