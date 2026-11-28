import { describe, expect, it } from 'vitest';

import { appsFromEnv, appsStartupLine } from '../src/index';

const entry = { id: 'demo', name: 'Demo support', baseUrl: 'https://demo.example/', repo: 'acme/demo', tokenEnv: 'APP_INTAKE_DEMO_TOKEN' };

describe('appsFromEnv', () => {
  it('is off with no APP_INTAKE_APPS', () => {
    expect(appsFromEnv({})).toEqual({ apps: [], problems: [] });
    expect(appsStartupLine(appsFromEnv({}))).toContain('off');
  });

  it('reads an app and its token from the named variable', () => {
    const result = appsFromEnv({ APP_INTAKE_APPS: JSON.stringify([entry]), APP_INTAKE_DEMO_TOKEN: ' secret-1 ' });
    expect(result.problems).toEqual([]);
    expect(result.apps).toEqual([{ ...entry, baseUrl: 'https://demo.example', token: 'secret-1' }]);
  });

  it('never puts the token in the startup line', () => {
    const line = appsStartupLine(appsFromEnv({ APP_INTAKE_APPS: JSON.stringify([entry]), APP_INTAKE_DEMO_TOKEN: 'secret-1' }));
    expect(line).toContain('demo -> acme/demo');
    expect(line).not.toContain('secret-1');
  });

  it('leaves out an app whose token is not set, and says why', () => {
    const result = appsFromEnv({ APP_INTAKE_APPS: JSON.stringify([entry]) });
    expect(result.apps).toEqual([]);
    expect(result.problems.join()).toContain('APP_INTAKE_DEMO_TOKEN is not set');
  });

  it('refuses malformed input without throwing', () => {
    expect(appsFromEnv({ APP_INTAKE_APPS: '{nope' }).problems[0]).toContain('not valid JSON');
    expect(appsFromEnv({ APP_INTAKE_APPS: '{}' }).problems[0]).toContain('JSON array');
    const bad = appsFromEnv({
      APP_INTAKE_APPS: JSON.stringify([
        { ...entry, id: 'Bad Id' },
        { ...entry, baseUrl: 'http://demo.example' },
        { ...entry, repo: 'nope' },
        { ...entry, tokenEnv: 'lower' },
      ]),
      APP_INTAKE_DEMO_TOKEN: 't',
    });
    expect(bad.apps).toEqual([]);
    expect(bad.problems).toHaveLength(4);
  });

  it('allows http only for localhost, and drops a repeated id', () => {
    const result = appsFromEnv({
      APP_INTAKE_APPS: JSON.stringify([{ ...entry, baseUrl: 'http://localhost:3210' }, entry]),
      APP_INTAKE_DEMO_TOKEN: 't',
    });
    expect(result.apps.map(app => app.baseUrl)).toEqual(['http://localhost:3210']);
    expect(result.problems.join()).toContain('listed twice');
  });
});
