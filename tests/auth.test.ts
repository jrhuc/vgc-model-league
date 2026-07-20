import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AuthError, AuthService } from '../src/auth.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('GitHub OAuth uses state and PKCE, then creates a hashed durable session', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgcleague-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, 'league.sqlite');
  let verifier = '';
  let bearer = '';
  const request = (async (input, init) => {
    if (String(input).includes('/login/oauth/access_token')) {
      const body = new URLSearchParams(String(init?.body));
      verifier = body.get('code_verifier') ?? '';
      assert.equal(body.get('client_secret'), 'client-secret');
      assert.equal(body.get('redirect_uri'), 'https://league.example/auth/github/callback');
      return json({ access_token: 'github-access-token', token_type: 'bearer', scope: '' });
    }
    bearer = new Headers(init?.headers).get('authorization') ?? '';
    return json({ id: 42, login: 'octocat', avatar_url: 'https://avatars.example/octocat' });
  }) as typeof fetch;
  const auth = new AuthService({
    dbPath: database,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    publicOrigin: 'https://league.example',
    operatorSubjects: ['42'],
    fetch: request,
  });

  const login = auth.beginLogin();
  const location = new URL(login.location);
  assert.equal(location.origin, 'https://github.com');
  assert.equal(location.searchParams.get('state'), login.state);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.has('scope'), false);

  const result = await auth.completeLogin('temporary-code', login.state, login.state, undefined);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), location.searchParams.get('code_challenge'));
  assert.equal(bearer, 'Bearer github-access-token');
  assert.equal(result.session.user.providerSubject, '42');
  assert.equal(result.session.user.login, 'octocat');
  assert.equal(result.session.user.role, 'operator');
  assert.deepEqual(auth.session(result.sessionToken), result.session);
  assert.throws(() => auth.authorize(result.sessionToken, 'wrong', 'reader'), /invalid CSRF token/);
  assert.equal(
    auth.authorize(result.sessionToken, result.session.csrfToken, 'operator').user.id,
    result.session.user.id,
  );
  await assert.rejects(
    auth.completeLogin('temporary-code', login.state, login.state, undefined),
    (error: unknown) => error instanceof AuthError && error.status === 400,
  );

  auth.startExperiment(result.session.user, 'run-1', 'test', { models: ['random', 'random'] });
  assert.equal(auth.canControlExperiment(result.session.user, 'run-1'), true);
  auth.stopExperiment(result.session.user, 'run-1');
  auth.finishExperiment('run-1', 'stopped');
  auth.finishExperiment('run-1', 'failed');
  auth.recordPool(result.session.user, 'pool-1', 'gen9championsvgc2026regmbbo3');
  auth.logout(result.sessionToken, result.session.csrfToken);
  assert.equal(auth.session(result.sessionToken), undefined);
  auth.close();

  const inspection = new DatabaseSync(database, { readOnly: true });
  const storedSession = inspection.prepare('SELECT token_hash FROM sessions').get();
  const experiment = inspection.prepare("SELECT status FROM experiments WHERE run_id = 'run-1'").get() as {
    status: string;
  };
  assert.equal(experiment.status, 'stopped');
  assert.equal(storedSession, undefined);
  const audit = inspection.prepare('SELECT action FROM audit_events ORDER BY id').all() as Array<{ action: string }>;
  assert.deepEqual(
    audit.map((entry) => entry.action),
    ['auth.login', 'experiment.start', 'experiment.stop', 'experiment.stopped', 'pool.publish', 'auth.logout'],
  );
  inspection.close();
});

test('v1 experiment tables migrate to the stopped terminal state', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgcleague-auth-v1-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'league.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES (1, 1);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      login TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE experiments (
      run_id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
      config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    ) STRICT;
    CREATE INDEX experiments_owner_user_id ON experiments(owner_user_id);
  `);
  legacy.close();

  new AuthService({
    dbPath,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    publicOrigin: 'https://league.example',
  }).close();

  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  const table = migrated.prepare("SELECT sql FROM sqlite_master WHERE name = 'experiments'").get() as { sql: string };
  assert.match(table.sql, /'stopped'/);
  assert.ok(migrated.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get());
  migrated.close();
});

test('sessions expire and contributor ownership gates another user', async () => {
  let now = 1_000;
  let profileId = 1;
  const request = (async (input) =>
    String(input).includes('/login/oauth/access_token')
      ? json({ access_token: `token-${profileId}` })
      : json({ id: profileId, login: `user-${profileId}`, avatar_url: '' })) as typeof fetch;
  const auth = new AuthService({
    dbPath: ':memory:',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    publicOrigin: 'https://league.example',
    fetch: request,
    now: () => now,
  });
  const firstFlow = auth.beginLogin();
  const first = await auth.completeLogin('code-1', firstFlow.state, firstFlow.state, undefined);
  auth.startExperiment(first.session.user, 'owned-run', 'test', {});

  profileId = 2;
  const secondFlow = auth.beginLogin();
  const second = await auth.completeLogin('code-2', secondFlow.state, secondFlow.state, undefined);
  assert.throws(() => auth.stopExperiment(second.session.user, 'owned-run'), /only the run owner/);
  assert.throws(() => auth.authorize(second.sessionToken, second.session.csrfToken, 'operator'), /insufficient role/);

  now += 8 * 24 * 60 * 60 * 1000;
  assert.equal(auth.session(first.sessionToken), undefined);
  auth.close();
});

test('service restart records interrupted experiments as failed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgcleague-auth-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'league.sqlite');
  const request = (async (input) =>
    String(input).includes('/login/oauth/access_token')
      ? json({ access_token: 'token' })
      : json({ id: 7, login: 'recoverable', avatar_url: '' })) as typeof fetch;
  const options = {
    dbPath,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    publicOrigin: 'https://league.example',
    fetch: request,
  };
  const first = new AuthService(options);
  const flow = first.beginLogin();
  const login = await first.completeLogin('code', flow.state, flow.state, undefined);
  first.startExperiment(login.session.user, 'interrupted-run', 'test', {});
  first.close();

  const restarted = new AuthService(options);
  restarted.startExperiment(login.session.user, 'replacement-run', 'test', {});
  restarted.finishExperiment('replacement-run', 'done');
  restarted.close();

  const inspection = new DatabaseSync(dbPath, { readOnly: true });
  const interrupted = inspection
    .prepare('SELECT status, ended_at FROM experiments WHERE run_id = ?')
    .get('interrupted-run') as { status: string; ended_at: number | null };
  assert.equal(interrupted.status, 'failed');
  assert.equal(typeof interrupted.ended_at, 'number');
  const actions = inspection
    .prepare("SELECT action FROM audit_events WHERE resource_id = 'interrupted-run'")
    .all() as Array<{ action: string }>;
  assert.deepEqual(
    actions.map((entry) => entry.action),
    ['experiment.start', 'experiment.failed'],
  );
  inspection.close();
});

test('pending OAuth flows are bounded', () => {
  const auth = new AuthService({
    dbPath: ':memory:',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    publicOrigin: 'https://league.example',
  });
  for (let index = 0; index < 1024; index += 1) auth.beginLogin();
  assert.throws(
    () => auth.beginLogin(),
    (error: unknown) => error instanceof AuthError && error.status === 429,
  );
  auth.close();
});
