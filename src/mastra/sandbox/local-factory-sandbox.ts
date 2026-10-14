/**
 * The `local` sandbox provider, with native isolation.
 *
 * `@mastra/factory` 0.22 ships `LocalFactorySandbox`, but it constructs a bare
 * `LocalSandbox` with no `isolation` (`@mastra/factory`
 * `dist/sandbox/local-factory-sandbox.js`), and `LocalSandbox` defaults that to
 * `'none'`. Using it would run agent commands unconfined on macOS and Linux,
 * where a backend exists. This is the same provider with the backend passed in.
 *
 * `allowNetwork` is on because both backends otherwise deny all network
 * (seatbelt: `deny network*`; bwrap: `--unshare-net`), and the Factory clones,
 * fetches and pushes through this sandbox: a confined session could not open
 * its workspace. Isolation here confines writes (and, under bwrap, reads).
 *
 * Under isolation the home directory is not writable (seatbelt allows writes
 * only to the workspace and temp dirs), so `npm install` fails writing its
 * cache to `~/.npm`. Package caches therefore go to `.cache` in the session
 * directory, beside the checkout rather than in it. Reproduced on Linux with
 * a read-only home: npm fails with the default cache and succeeds with this.
 */
import { join } from 'node:path';
import { FactorySandbox, LocalSandbox } from '@mastra/core/workspace';
import type { FactorySandboxContext, IsolationBackend } from '@mastra/core/workspace';

export interface IsolatedLocalFactorySandboxOptions {
  /** Directory under which every session gets its own working directory. */
  root: string;
  /** Environment for commands run in the sandbox. */
  env?: Record<string, string>;
  /** Native backend, resolved once at boot by `getRecommendedIsolation()`. */
  isolation: IsolationBackend;
}

export class IsolatedLocalFactorySandbox extends FactorySandbox<Record<string, never>> {
  readonly provider = 'local';
  readonly #options: IsolatedLocalFactorySandboxOptions;

  constructor(options: IsolatedLocalFactorySandboxOptions) {
    super();
    this.#options = options;
  }

  create(ctx: FactorySandboxContext): LocalSandbox {
    const workingDirectory = join(this.#options.root, ctx.sessionId);
    const env =
      this.#options.isolation === 'none'
        ? this.#options.env
        : {
            npm_config_cache: join(workingDirectory, '.cache', 'npm'),
            XDG_CACHE_HOME: join(workingDirectory, '.cache'),
            ...this.#options.env,
          };
    return new LocalSandbox({
      id: ctx.sessionId,
      workingDirectory,
      ...(env ? { env } : {}),
      isolation: this.#options.isolation,
      nativeSandbox: { allowNetwork: true },
    });
  }
}
