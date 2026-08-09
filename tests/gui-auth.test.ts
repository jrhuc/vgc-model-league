import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { AuthService } from '../src/auth.js';
import { GuiServer } from '../src/gui/server.js';
import type { runRotation } from '../src/rotation.js';

const RUNS_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-runs-'));
after(() => fs.rmSync(RUNS_SCRATCH, { recursive: true, force: true }));

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(
  port: number,
  options: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
  const outgoing = http.request(
    {
      host: '127.0.0.1',
      port,
      path: options.path,
      method: options.method ?? 'GET',
      headers: { host: 'league.example', ...(options.headers ?? {}) },
    },
    (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () =>
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    },
  );
  outgoing.on('error', reject);
  outgoing.end(options.body);
  return promise;
}

function firstEvent(port: number, path: string): Promise<RawResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
  const outgoing = http.request({ host: '127.0.0.1', port, path, headers: { host: 'league.example' } }, (incoming) => {
    let body = '';
    incoming.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (!body.includes('\n\n')) return;
      resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body });
      incoming.destroy();
    });
  });
  outgoing.on('error', reject);
  outgoing.end();
  return promise;
}

function eventStream(
  port: number,
  path: string,
  headers: Record<string, string>,
): { ready: Promise<number>; battle: Promise<string>; close: () => void } {
  const ready = Promise.withResolvers<number>();
  const battle = Promise.withResolvers<string>();
  let incoming: http.IncomingMessage | undefined;
  let body = '';
  const outgoing = http.request(
    { host: '127.0.0.1', port, path, headers: { host: 'league.example', ...headers } },
    (response) => {
      incoming = response;
      ready.resolve(response.statusCode ?? 0);
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.includes('"type":"battle"')) battle.resolve(body);
      });
    },
  );
  outgoing.on('error', (error) => {
    ready.reject(error);
    battle.reject(error);
  });
  outgoing.end();
  return {
    ready: ready.promise,
    battle: battle.promise,
    close: () => {
      incoming?.destroy();
      outgoing.destroy();
    },
  };
}

function cookieValue(headers: http.IncomingHttpHeaders, name: string): string {
  const cookies = headers['set-cookie'] ?? [];
  for (const cookie of cookies) {
    if (cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1).split(';', 1)[0] ?? '';
  }
  return '';
}

async function login(port: number): Promise<{ cookie: string; csrf: string; login: string }> {
  const start = await request(port, { path: '/auth/github' });
  assert.equal(start.status, 302);
  const location = new URL(String(start.headers.location));
  const state = location.searchParams.get('state') ?? '';
  const stateCookie = cookieValue(start.headers, 'vgc_oauth_state');
  assert.equal(stateCookie, state);

  const callback = await request(port, {
    path: `/auth/github/callback?code=temporary-code&state=${encodeURIComponent(state)}`,
    headers: { cookie: `vgc_oauth_state=${stateCookie}` },
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, '/');
  const sessionToken = cookieValue(callback.headers, 'vgc_session');
  assert.ok(sessionToken);

  const stateResponse = await request(port, {
    path: '/api/state',
    headers: { cookie: `vgc_session=${sessionToken}` },
  });
  assert.equal(stateResponse.status, 200);
  const stateBody = JSON.parse(stateResponse.body) as {
    auth: { csrfToken: string; user: { login: string; role: string } };
  };
  assert.equal(stateBody.auth.user.role, 'contributor');
  return { cookie: `vgc_session=${sessionToken}`, csrf: stateBody.auth.csrfToken, login: stateBody.auth.user.login };
}

test('hosted GitHub OAuth protects mutations with sessions, CSRF, and run ownership', {
  timeout: 15_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgcleague-gui-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let profileId = 1;
  const github = (async (input) =>
    String(input).includes('/login/oauth/access_token')
      ? new Response(JSON.stringify({ access_token: `token-${profileId}` }))
      : new Response(JSON.stringify({ id: profileId, login: `user-${profileId}`, avatar_url: '' }))) as typeof fetch;
  const auth = new AuthService({
    dbPath: path.join(directory, 'league.sqlite'),
    clientId: 'client-id',
    clientSecret: 'client-secret',
    publicOrigin: 'https://league.example',
    fetch: github,
  });
  let emitLateUpdate: (() => void) | undefined;
  const runner = (async (_models, _seriesPerPair, _runDir, options) => {
    options?.onEvent?.({
      type: 'plans',
      mode: 'rotation',
      protocolVersion: 1,
      plans: [{ index: 0, players: { p1: 'random', p2: 'random' } }],
      pool: 'test',
      seed: 1,
    });
    options?.onEvent?.({ type: 'series-start', index: 0 });
    options?.onEvent?.({
      type: 'game-update',
      index: 0,
      game: 1,
      lines: ['|switch|p1a: Alpha|Pikachu, L50|100/200'],
      publicLines: ['|switch|p1a: Alpha|Pikachu, L50|50/100'],
    });
    emitLateUpdate = () =>
      options?.onEvent?.({
        type: 'game-update',
        index: 0,
        game: 1,
        lines: ['|-damage|p1a: Alpha|80/200', '|win|random'],
        publicLines: ['|-damage|p1a: Alpha|40/100', '|win|random'],
      });
    const signal = options?.signal;
    if (!signal?.aborted) {
      const gate = Promise.withResolvers<void>();
      signal?.addEventListener('abort', () => gate.resolve(), { once: true });
      await gate.promise;
    }
    return [];
  }) as typeof runRotation;
  const gui = new GuiServer({
    runsDir: RUNS_SCRATCH,
    host: '127.0.0.1',
    publicOrigin: 'https://league.example',
    auth,
    runner,
    recordsPath: path.join(directory, 'records.jsonl'),
  });
  await gui.listen(0);
  const address = gui.server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  let ownerStream: ReturnType<typeof eventStream> | undefined;

  try {
    const anonymous = await request(port, { path: '/api/state' });
    assert.equal(anonymous.status, 200);
    const anonymousBody: unknown = JSON.parse(anonymous.body);
    assert.ok(anonymousBody && typeof anonymousBody === 'object' && 'auth' in anonymousBody);
    assert.deepEqual(anonymousBody.auth, {
      mode: 'github',
      user: null,
      csrfToken: null,
    });
    assert.equal((await request(port, { path: '/api/events' })).status, 401);
    const publicEvents = await firstEvent(port, '/api/events/public');
    assert.equal(publicEvents.status, 200);
    assert.match(publicEvents.body, /"type":"run"/);
    assert.equal(
      (
        await request(port, {
          path: '/api/run/stop',
          method: 'POST',
          headers: { origin: 'https://league.example', 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );

    const owner = await login(port);
    assert.equal(
      (
        await request(port, {
          path: '/api/run/stop',
          method: 'POST',
          headers: {
            origin: 'https://league.example',
            'content-type': 'application/json',
            cookie: owner.cookie,
            'x-csrf-token': 'wrong',
          },
          body: '{}',
        })
      ).status,
      403,
    );
    const started = await request(port, {
      path: '/api/run',
      method: 'POST',
      headers: {
        origin: 'https://league.example',
        'content-type': 'application/json',
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
      },
      body: JSON.stringify({
        models: ['random', 'random'],
        pool: 'test',
        seriesPerPair: 1,
        concurrency: 1,
        apiKeys: {},
      }),
    });
    assert.equal(started.status, 200, started.body);
    const ownerState = JSON.parse(
      (await request(port, { path: '/api/state', headers: { cookie: owner.cookie } })).body,
    ) as {
      run: { canControl: boolean };
    };
    assert.equal(ownerState.run.canControl, true);
    const publicState = JSON.parse((await request(port, { path: '/api/state' })).body) as {
      run: Record<string, unknown>;
    };
    assert.equal('canControl' in publicState.run, false);
    const ownerBattle = await request(port, { path: '/api/battle?index=0', headers: { cookie: owner.cookie } });
    assert.equal(ownerBattle.status, 200);
    assert.match(ownerBattle.body, /100\/200/);
    const publicBattle = await request(port, { path: '/api/battle/public?index=0' });
    assert.equal(publicBattle.status, 200);
    assert.doesNotMatch(publicBattle.body, /50\/100|100\/200/);
    assert.match(publicBattle.body, /"visibility":"public"/);

    profileId = 2;
    const other = await login(port);
    const otherState = JSON.parse(
      (await request(port, { path: '/api/state', headers: { cookie: other.cookie } })).body,
    ) as {
      run: Record<string, unknown>;
    };
    assert.equal('canControl' in otherState.run, false);
    const forbiddenStop = await request(port, {
      path: '/api/run/stop',
      method: 'POST',
      headers: {
        origin: 'https://league.example',
        'content-type': 'application/json',
        cookie: other.cookie,
        'x-csrf-token': other.csrf,
      },
      body: '{}',
    });
    assert.equal(forbiddenStop.status, 403);
    const otherBattle = await request(port, { path: '/api/battle?index=0', headers: { cookie: other.cookie } });
    assert.equal(otherBattle.status, 200);
    assert.doesNotMatch(otherBattle.body, /50\/100|100\/200/);

    const stopped = await request(port, {
      path: '/api/run/stop',
      method: 'POST',
      headers: {
        origin: 'https://league.example',
        'content-type': 'application/json',
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
      },
      body: '{}',
    });
    assert.equal(stopped.status, 200);
    const otherAfterStop = JSON.parse(
      (await request(port, { path: '/api/state', headers: { cookie: other.cookie } })).body,
    ) as { sampleTeams?: unknown[]; run: Record<string, unknown> };
    assert.ok(Array.isArray(otherAfterStop.sampleTeams), 'contributors retain setup data after another owner stops');
    assert.equal('error' in otherAfterStop.run, false, "the other owner's stopped run remains public-projected");

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(port, {
        path: '/api/models',
        method: 'POST',
        headers: {
          origin: 'https://league.example',
          'content-type': 'application/json',
          cookie: owner.cookie,
          'x-csrf-token': owner.csrf,
        },
        body: '{"provider":"missing"}',
      });
      assert.equal(response.status, 400);
    }
    const limited = await request(port, {
      path: '/api/models',
      method: 'POST',
      headers: {
        origin: 'https://league.example',
        'content-type': 'application/json',
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
      },
      body: '{"provider":"missing"}',
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);

    ownerStream = eventStream(port, '/api/events', { cookie: owner.cookie });
    assert.equal(await ownerStream.ready, 200);

    const logout = await request(port, {
      path: '/api/logout',
      method: 'POST',
      headers: {
        origin: 'https://league.example',
        'content-type': 'application/json',
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
      },
      body: '{}',
    });
    assert.equal(logout.status, 200);
    assert.equal(cookieValue(logout.headers, 'vgc_session'), '');
    emitLateUpdate?.();
    const afterLogout = await ownerStream.battle;
    assert.match(afterLogout, /"visibility":"public"/);
    assert.match(afterLogout, /won the game/);
  } finally {
    ownerStream?.close();
    await gui.shutdown(1_000);
    auth.close();
  }
});
