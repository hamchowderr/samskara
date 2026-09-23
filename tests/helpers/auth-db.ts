import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';

/**
 * A real libSQL file in a fresh temp directory, shaped like the handle
 * `LibSQLFactoryStorage.authDatabase()` returns. Call `cleanup()` when done.
 */
export function tempAuthDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'samskara-test-'));
  const client: Client = createClient({ url: `file:${join(dir, 'auth.db').replace(/\\/g, '/')}` });
  return {
    client,
    database: { dialect: 'libsql', client },
    cleanup() {
      client.close();
      // Windows can hold the SQLite file briefly after close. It is a temp
      // directory, so if it will not go the OS removes it later; failing the
      // test over it would hide real results.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    },
  };
}

/** A 32+ character secret; Better Auth rejects short ones. */
export const TEST_SECRET = 'test-secret-that-is-long-enough-0123456789';

/** Sign up and return the cookie header for that session. */
export async function signUp(
  auth: { api: { signUpEmail: (input: never) => Promise<unknown> } },
  email: string,
): Promise<{ userId: string; headers: Headers }> {
  const result = (await auth.api.signUpEmail({
    body: { email, password: 'Passw0rd!long-enough', name: email.split('@')[0] },
    returnHeaders: true,
  } as never)) as { headers: Headers; response: { user: { id: string } } };
  return { userId: result.response.user.id, headers: cookieHeaders(result.headers) };
}

/** Sign in again, which creates a NEW session. */
export async function signIn(
  auth: { api: { signInEmail: (input: never) => Promise<unknown> } },
  email: string,
): Promise<Headers> {
  const result = (await auth.api.signInEmail({
    body: { email, password: 'Passw0rd!long-enough' },
    returnHeaders: true,
  } as never)) as { headers: Headers };
  return cookieHeaders(result.headers);
}

function cookieHeaders(responseHeaders: Headers): Headers {
  const cookies = responseHeaders
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ');
  return new Headers({ cookie: cookies });
}
